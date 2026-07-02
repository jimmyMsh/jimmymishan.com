import { formatRange } from "../dates";
import type { Line, VfsFile } from "./types";
import { hint, link, text } from "./types";

export interface WorkEntryData {
  role: string;
  company: string;
  start: string;
  end: string | null;
  summary: string;
  highlights: string[];
}

export interface ProjectEntryData {
  name: string;
  summary: string;
  tags?: string[];
  repo?: string;
  link?: string;
}

export interface ContentMeta {
  email: string;
  githubUrl: string;
  linkedinUrl: string;
}

const BLANK = text("");

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

function linkLine(label: string, url: string): Line {
  return {
    segments: [{ text: label }, link(stripProtocol(url), url)],
    kind: "output",
  };
}

export function buildFiles(
  work: WorkEntryData[],
  projects: ProjectEntryData[],
  meta: ContentMeta,
): VfsFile[] {
  const workLines: Line[] = [];
  for (const [i, entry] of work.entries()) {
    if (i > 0) workLines.push(BLANK);
    workLines.push(
      text(
        `${entry.role} @ ${entry.company}   (${formatRange(entry.start, entry.end)})`,
      ),
      text(`    ${entry.summary}`),
      ...entry.highlights.map((h) => text(`    - ${h}`)),
    );
  }

  const projectLines: Line[] = [];
  for (const [i, project] of projects.entries()) {
    if (i > 0) projectLines.push(BLANK);
    projectLines.push(text(`${project.name} — ${project.summary}`));
    if (project.repo) projectLines.push(linkLine("    repo: ", project.repo));
    if (project.link) projectLines.push(linkLine("    live: ", project.link));
  }

  return [
    {
      name: "about.txt",
      lines: [
        text("production engineer @ meta."),
        text("I care about systems that stay up quietly: good observability,"),
        text("boring deploys, infrastructure sized to the job — like this"),
        text(
          "site, which runs on a 1 GB VPS you can inspect from the browser.",
        ),
        text("rutgers grad (CS + IT&I). I lift, hunt down good food around"),
        text("NYC, and build things: computers, servers, side projects."),
        BLANK,
        hint("# full version: `open about`"),
      ],
    },
    { name: "work.txt", lines: workLines },
    { name: "projects.txt", lines: projectLines },
    {
      name: "contact.txt",
      lines: [
        {
          segments: [
            { text: "email:     " },
            link(meta.email, `mailto:${meta.email}`),
          ],
          kind: "output",
        },
        linkLine("github:    ", meta.githubUrl),
        linkLine("linkedin:  ", meta.linkedinUrl),
      ],
    },
    {
      name: "resume.pdf",
      lines: [],
      binary: {
        message: "resume.pdf is a binary file — opening /resume …",
        navigateTo: "/resume",
      },
    },
    {
      name: ".plan",
      hidden: true,
      lines: [
        text("keep it fast. keep it boring. keep it online."),
        hint("# next: live telemetry from this box (soon)"),
      ],
    },
  ];
}
