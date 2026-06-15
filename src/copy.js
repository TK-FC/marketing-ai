// Canonical member-facing copy for the states the WORKER produces (not the model).
// Program voice, sentence case, no em dashes. These strings are sent to the browser as
// UTF-8, so straight apostrophes render correctly.
//
// The non-answer copy the MODEL produces (out-of-bounds, partial, people, coach) lives in the
// system prompt (prompt/00-system-frame.md), not here. Keep the two in sync if either changes.

export const COPY = {
  // Daily per-IP cap reached. Shown as an assistant message; input then disabled until reset.
  dailyLimit:
    "You've hit today's question limit. Back tomorrow, or bring the rest to the Monday Marketing call.",

  // Monthly cost ceiling reached. Returned without calling the provider.
  monthlyCeiling:
    "The tool's at capacity for this month. Bring your question to the Monday Marketing call and the team will look after you.",

  // Provider error or timeout. The attempt does not consume the daily count.
  providerError:
    "That one didn't get through, give it another go.",
};

// State flag sent on the x-fc-state response header so the frontend knows how to behave.
export const STATE = {
  OK: "ok",
  DAILY_LIMIT: "daily_limit",
  MONTHLY_CEILING: "monthly_ceiling",
  BURST: "burst",
  ERROR: "error",
  GATE: "gate",
  BAD_INPUT: "bad_input",
};
