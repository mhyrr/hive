// Sundial Systems — a fictional 12-person B2B SaaS building clinic
// scheduling software ("Sundial"). Timeline: 2025-01-06 → 2025-06-30.
// Every person, clinic, customer, and incident here is invented.

import type { Actor, Channel } from "../tools/types.ts";

export const ORG = {
  name: "Sundial Systems",
  domain: "sundialhq.test", // reserved TLD — never a real org
  timeline: { start: "2025-01-06", end: "2025-06-30" },
};

export const ACTORS: Actor[] = [
  { id: "maya",   name: "Maya Okafor",   team: "exec",    slack: "U0AA00001", email: "maya@sundialhq.test" },
  { id: "dev",    name: "Dev Batra",     team: "eng",     slack: "U0AA00002", email: "dev@sundialhq.test",
    git: [{ key: "dev",  name: "Dev Batra", email: "dev@sundialhq.test" }] },
  { id: "priya",  name: "Priya Shenoy",  team: "eng",     slack: "U0AA00003", email: "priya@sundialhq.test",
    git: [{ key: "priya", name: "Priya Shenoy", email: "priya@sundialhq.test" }] },
  // Tom commits under two identities — entity-resolution gold.
  { id: "tom",    name: "Tom Hale",      team: "eng",     slack: "U0AA00004", email: "tom@sundialhq.test",
    git: [
      { key: "tom",     name: "Tom Hale", email: "tom@sundialhq.test" },
      { key: "tom-alt", name: "tomhale",  email: "tom.hale.dev@fastmail.test" },
    ] },
  { id: "lena",   name: "Lena Fischer",  team: "eng",     slack: "U0AA00005", email: "lena@sundialhq.test",
    git: [{ key: "lena", name: "Lena Fischer", email: "lena@sundialhq.test" }] },
  { id: "marcus", name: "Marcus Webb",   team: "eng",     slack: "U0AA00006", email: "marcus@sundialhq.test",
    git: [{ key: "marcus", name: "Marcus Webb", email: "marcus@sundialhq.test" }] },
  { id: "ana",    name: "Ana Reyes",     team: "eng",     slack: "U0AA00007", email: "ana@sundialhq.test",
    git: [{ key: "ana", name: "Ana Reyes", email: "ana@sundialhq.test" }] },
  { id: "jules",  name: "Jules Park",    team: "product", slack: "U0AA00008", email: "jules@sundialhq.test" },
  { id: "sofia",  name: "Sofia Marino",  team: "product", slack: "U0AA00009", email: "sofia@sundialhq.test" },
  { id: "ray",    name: "Ray Donnelly",  team: "gtm",     slack: "U0AA00010", email: "ray@sundialhq.test" },
  { id: "nadia",  name: "Nadia Hassan",  team: "gtm",     slack: "U0AA00011", email: "nadia@sundialhq.test" },
  { id: "colin",  name: "Colin Zhu",     team: "gtm",     slack: "U0AA00012", email: "colin@sundialhq.test" },
  // Agent actor — is_agent flag exercises §4.1 actor records.
  { id: "deploybot", name: "deploybot",  team: "eng", is_agent: true,
    slack: "U0AA00013", email: "deploybot@sundialhq.test",
    git: [{ key: "deploybot", name: "deploybot", email: "deploybot@sundialhq.test" }] },
];

export const CHANNELS: Channel[] = [
  { name: "general",   topic: "All of Sundial",
    members: ["maya","dev","priya","tom","lena","marcus","ana","jules","sofia","ray","nadia","colin","deploybot"] },
  { name: "eng",       topic: "Engineering",
    members: ["dev","priya","tom","lena","marcus","ana","jules","deploybot"] },
  { name: "incidents", topic: "Sev tracking — see docs/runbooks/incidents.md",
    members: ["dev","priya","tom","lena","marcus","ana","jules","maya","nadia","deploybot"] },
  { name: "product",   topic: "Product & design",
    members: ["jules","sofia","lena","marcus","dev","maya","nadia"] },
  { name: "gtm",       topic: "Sales & customer success",
    members: ["ray","nadia","colin","maya","jules"] },
];
