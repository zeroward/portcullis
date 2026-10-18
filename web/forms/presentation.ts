import type { FieldSpec } from "./schema.js";

export interface PresentedField {
  field: FieldSpec;
  path: string;
  group: string;
  advanced?: boolean;
}
// Presentation paths are independent of payload construction and validation.
export function presentFields(
  fields: FieldSpec[],
  service: boolean,
): PresentedField[] {
  if (service) {
    const groups: Record<string, string[]> = {
      Basics: ["name", "slug", "summary", "metadata.type", "metadata.category"],
      Presentation: [
        "metadata.tags",
        "metadata.description",
        "metadata.icon",
        "metadata.cover",
        "metadata.screenshots",
        "metadata.sortOrder",
      ],
      Connections: [
        "metadata.endpoints",
        "metadata.instructions",
        "metadata.requiredClient",
        "metadata.links",
      ],
      "Access & dependencies": [
        "visibility",
        "entitlementIds",
        "dependencies",
        "metadata.provider",
        "metadata.rules",
      ],
    };
    return fields
      .flatMap((f) =>
        f.key === "metadata"
          ? f.fields!.map((child) => ({
              field: child,
              path: `metadata.${child.key}`,
            }))
          : [{ field: f, path: f.key }],
      )
      .map((item) => {
        const group =
          Object.keys(groups).find((g) => groups[g].includes(item.path)) ??
          "Service information";
        return {
          ...item,
          group: item.field.group ?? group,
          advanced: group !== "Basics",
        };
      })
      .sort(
        (a, b) =>
          [...Object.keys(groups), "Service information"].indexOf(a.group) -
          [...Object.keys(groups), "Service information"].indexOf(b.group),
      );
  }
  return fields.map((field) => ({
    field,
    path: field.key,
    group:
      field.group ??
      (field.kind === "object"
        ? field.label
        : /reason|confirmation/.test(field.key)
          ? "Review details"
          : /roles|groups|prerequisites|entitlement|serviceId|scope/i.test(
                field.key,
              )
            ? "Access & scope"
            : "Basics"),
    advanced: field.advanced,
  }));
}
