import { describe, expect, test } from "bun:test"
import { InstructionVariable } from "@opencode/core/instruction-variable"

describe("InstructionVariable.substitute", () => {
  test("substitutes environment and project variables together", () => {
    expect(
      InstructionVariable.substitute(
        "{env:OPENCODE_TEST_ORGANIZATION}: {project:project_id}, {project:project_name}, {project:work_package_id}; {env:OPENCODE_TEST_ORGANIZATION}",
        {
          env: { OPENCODE_TEST_ORGANIZATION: "Organization" },
          project: { project_id: 42, project_name: "设计 $&", work_package_id: 123 },
        },
      ),
    ).toBe("Organization: 42, 设计 $&, 123; Organization")
  })

  test("expands missing values to empty strings while preserving unsupported placeholders", () => {
    expect(
      InstructionVariable.substitute(
        "{env:OPENCODE_TEST_VARIABLE_UNSET}|{project:project_id}|{project:project_name}|{project:work_package_id}|{project:name}|{file:rules.md}",
        { project: null },
      ),
    ).toBe("||||{project:name}|{file:rules.md}")
  })

  test("preserves project placeholders when no project context is supplied", () => {
    expect(
      InstructionVariable.substitute("{env:OPENCODE_TEST_VALUE}|{project:project_id}", {
        env: { OPENCODE_TEST_VALUE: "configured" },
      }),
    ).toBe("configured|{project:project_id}")
  })

  test("keeps inserted values literal without recursively expanding placeholders", () => {
    expect(
      InstructionVariable.substitute("{env:OPENCODE_TEST_VALUE}|{project:project_name}", {
        env: { OPENCODE_TEST_VALUE: "{project:project_id} $&" },
        project: { project_id: 42, project_name: "{env:OPENCODE_TEST_VALUE} $&", work_package_id: 123 },
      }),
    ).toBe("{project:project_id} $&|{env:OPENCODE_TEST_VALUE} $&")
  })
})
