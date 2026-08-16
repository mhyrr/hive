/**
 * CSS for the HIVE Morning Edition dashboard.
 *
 * Design intent: broadsheet newspaper, not SaaS dashboard.
 * Serif everywhere, cream/ink/amber palette, hairline rules, no shadows,
 * no icons, no emojis, no border-radius above 2px. System fonts only.
 *
 * Split into logical modules; this barrel concatenates them into a single
 * template-literal string for inline <style> injection.
 */

export { BASE_CSS } from "./base";
export { YARD_CSS } from "./yard";
export { MASTHEAD_CSS } from "./masthead";
export { NAVIGATION_CSS } from "./navigation";
export { SECTIONS_CSS } from "./sections";
export { BRIEFING_CSS } from "./briefing";
export { TABLES_CSS } from "./tables";
export { REFLECTIONS_CSS } from "./reflections";
export { TICKETS_CSS } from "./tickets";
export { TASTE_CSS } from "./taste";
export { WATCHES_CSS } from "./watches";
export { ARCHIVE_CSS } from "./archive";
export { INTERACTIVE_CSS } from "./interactive";
export { RESPONSIVE_CSS } from "./responsive";

import { BASE_CSS } from "./base";
import { YARD_CSS } from "./yard";
import { MASTHEAD_CSS } from "./masthead";
import { NAVIGATION_CSS } from "./navigation";
import { SECTIONS_CSS } from "./sections";
import { BRIEFING_CSS } from "./briefing";
import { TABLES_CSS } from "./tables";
import { REFLECTIONS_CSS } from "./reflections";
import { TICKETS_CSS } from "./tickets";
import { TASTE_CSS } from "./taste";
import { WATCHES_CSS } from "./watches";
import { ARCHIVE_CSS } from "./archive";
import { INTERACTIVE_CSS } from "./interactive";
import { RESPONSIVE_CSS } from "./responsive";

/** Full concatenated CSS — drop-in replacement for the former monolith. */
export const DASHBOARD_CSS = [
  BASE_CSS,
  YARD_CSS,
  MASTHEAD_CSS,
  NAVIGATION_CSS,
  SECTIONS_CSS,
  BRIEFING_CSS,
  TABLES_CSS,
  REFLECTIONS_CSS,
  TICKETS_CSS,
  TASTE_CSS,
  WATCHES_CSS,
  ARCHIVE_CSS,
  INTERACTIVE_CSS,
  RESPONSIVE_CSS,
].join("\n");
