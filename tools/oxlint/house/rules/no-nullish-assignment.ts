import { defineRule } from "@oxlint/plugins";

/** Disallow nullish coalescing assignment (`??=`). */
export const noNullishAssignmentRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow nullish coalescing assignment (`??=`)." },
    schema: [],
    messages: {
      nullishAssignment: "Nullish coalescing assignment (`??=`) is not allowed by house rules. Use an explicit assignment or conditional instead.",
    },
  },
  createOnce(context) {
    return {
      AssignmentExpression(node) {
        if (node.operator !== "??=") return;
        context.report({ node, messageId: "nullishAssignment" });
      },
    };
  },
});
