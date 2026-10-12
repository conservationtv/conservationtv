import { eslintCompatPlugin } from "@oxlint/plugins";

import { noInlineObjectTypeRule } from "./rules/no-inline-object-type.ts";
import { noNullishAssignmentRule } from "./rules/no-nullish-assignment.ts";
import { noObjectFreezeRule } from "./rules/no-object-freeze.ts";
import { noPrivateClassFieldsRule } from "./rules/no-private-class-fields.ts";
import { requireComplexityCommentRule } from "./rules/require-complexity-comment.ts";
import { requirePascalCaseSchemaNameRule } from "./rules/require-pascal-case-schema-name.ts";
import { requireZodOutputTypeRule } from "./rules/require-zod-output-type.ts";

/** Project-specific Oxlint rules for ConservationTV client style. */
const housePlugin = eslintCompatPlugin({
  meta: { name: "house" },
  rules: {
    "no-inline-object-type": noInlineObjectTypeRule,
    "no-nullish-assignment": noNullishAssignmentRule,
    "no-object-freeze": noObjectFreezeRule,
    "no-private-class-fields": noPrivateClassFieldsRule,
    "require-complexity-comment": requireComplexityCommentRule,
    "require-pascal-case-schema-name": requirePascalCaseSchemaNameRule,
    "require-zod-output-type": requireZodOutputTypeRule,
  },
});

export default housePlugin;
