import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const work = defineCollection({
  loader: glob({ pattern: "*.json", base: "./src/content/work" }),
  schema: ({ image }) =>
    z.object({
      role: z.string(),
      company: z.string(),
      start: z.string(), // "YYYY-MM" or a [PLACEHOLDER — …] marker
      end: z.string().nullable(), // null = present
      summary: z.string(), // one-line impact
      highlights: z.array(z.string()),
      link: z.url().optional(),
      logo: image().optional(),
      order: z.number(),
    }),
});

const projects = defineCollection({
  loader: glob({ pattern: "*.json", base: "./src/content/projects" }),
  schema: z.object({
    name: z.string(),
    summary: z.string(),
    highlights: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    repo: z.url().optional(),
    link: z.url().optional(),
    order: z.number(),
  }),
});

export const collections = { work, projects };
