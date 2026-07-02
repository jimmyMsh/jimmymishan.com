FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY site/package.json site/package.json
COPY api/package.json api/package.json
COPY e2e/package.json e2e/package.json
RUN npm ci -w site
COPY site site
RUN npm run -w site build

# Production image: real certificates issued and renewed via Let's Encrypt.
FROM jonasal/nginx-certbot:5 AS prod
COPY nginx/user_conf.d /etc/nginx/user_conf.d
COPY --from=build /repo/site/dist /usr/share/nginx/html

# Self-signed certificate for the local image, baked at the same paths the
# nginx config expects. Generated in a throwaway stage so openssl never ships
# in the runtime image.
FROM alpine:3 AS localcert
RUN apk add --no-cache openssl \
  && mkdir -p /certs \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
       -keyout /certs/privkey.pem \
       -out /certs/fullchain.pem \
       -subj "/CN=localhost" \
       -addext "subjectAltName=DNS:localhost,DNS:jimmymishan.com,IP:127.0.0.1" \
  && cp /certs/fullchain.pem /certs/chain.pem

# Local development image: stock nginx with the same config and a self-signed
# cert already in place. No certbot loop runs, so there is no reload-on-boot
# and none of the local-CA first-boot race the certbot image has.
FROM nginx:1.28 AS local
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/user_conf.d/jimmymishan.conf /etc/nginx/conf.d/jimmymishan.conf
COPY --from=localcert /certs /etc/letsencrypt/live/jimmymishan
COPY --from=build /repo/site/dist /usr/share/nginx/html
