import soulTemplate from "../../docs/SOUL.md" with { type: "text" };
import architectTemplate from "../../docs/personas/architect.md" with { type: "text" };
import craftsmanTemplate from "../../docs/personas/craftsman.md" with { type: "text" };
import criticTemplate from "../../docs/personas/critic.md" with { type: "text" };
import scoutTemplate from "../../docs/personas/scout.md" with { type: "text" };
import stewardTemplate from "../../docs/personas/steward.md" with { type: "text" };
import selfTemplate from "../../templates/SELF.md" with { type: "text" };
import configTemplate from "../../templates/config.md" with { type: "text" };
import projectConfigTemplate from "../../templates/project-config.md" with { type: "text" };
import planTemplate from "../../templates/PLAN.md" with { type: "text" };
import boardTemplate from "../../templates/BOARD.md" with { type: "text" };
import logTemplate from "../../templates/LOG.md" with { type: "text" };

export const baseTemplates = {
  "SOUL.md": soulTemplate.trim(),
  "SELF.md": selfTemplate.trim(),
  "config.md": configTemplate.trim(),
  "memory/knowledge.md": "# Knowledge\n\n(none yet)",
  "memory/decisions.md": "# Decisions\n\n(none yet)",
};

export const personaTemplates: Record<string, string> = {
  architect: architectTemplate.trim(),
  craftsman: craftsmanTemplate.trim(),
  critic: criticTemplate.trim(),
  scout: scoutTemplate.trim(),
  steward: stewardTemplate.trim(),
};

function renderTemplate(
  template: string,
  replacements: Record<string, string>,
): string {
  return Object.entries(replacements).reduce((result, [key, value]) => {
    return result.replaceAll(`{{${key}}}`, value);
  }, template);
}

export function renderProjectConfigTemplate(
  projectName: string,
  repoPath: string,
): string {
  return renderTemplate(projectConfigTemplate.trim(), {
    project_name: projectName,
    repo_path: repoPath,
  });
}

export function renderPlanTemplate(projectName: string): string {
  return renderTemplate(planTemplate.trim(), {
    project_name: projectName,
  });
}

export function renderBoardTemplate(): string {
  return boardTemplate.trim();
}

export function renderLogTemplate(projectName: string, dateLabel: string): string {
  return renderTemplate(logTemplate.trim(), {
    date: dateLabel,
    project_name: projectName,
  });
}

export function renderProjectMemoryTemplate(projectName: string): string {
  return `# Project Memory: ${projectName}

## Durable Facts
(none yet)

## Conventions
(none yet)

## Open Questions
(none yet)`;
}
