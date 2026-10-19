/**
 * Labels for the maintainer-authored `contribution` fields that generated
 * project skills carry as data (PRD SKL-03). Shared by the admin editor.
 */
import type { ContributionField } from "./project-schema.mjs";

export const CONTRIBUTION_LABELS: Record<
  ContributionField,
  { label: string; hint: string }
> = {
  approvedScope: {
    label: "Approved scope",
    hint: "The accepted outcomes. Required, 6 to 2000 characters.",
  },
  contributionGuide: {
    label: "Contribution guide",
    hint: "How to set up, branch and submit.",
  },
  supportedTasks: {
    label: "Supported tasks",
    hint: "The kinds of work the project wants.",
  },
  requiredTests: {
    label: "Required tests",
    hint: "Commands or workflows that must pass.",
  },
  reviewExpectations: {
    label: "Review expectations",
    hint: "Evidence a pull request must show for review.",
  },
  securityContact: {
    label: "Security contact",
    hint: "Where security reports go privately.",
  },
  closurePolicy: {
    label: "Closure policy",
    hint: "When maintainers close or decline a pull request.",
  },
  maintainerNotes: {
    label: "Maintainer notes",
    hint: "Anything else contributors should know.",
  },
};
