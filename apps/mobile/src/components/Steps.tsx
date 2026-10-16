/** A compact step indicator ("1 They show, you film · 2 Switch: you show, they film"). */
import { color, radius } from "@sealed/tokens";
import { Text, View } from "react-native";
import { fonts } from "../ui/kit";

export function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }} accessible accessibilityLabel={`Step ${current} of ${steps.length}: ${steps[current - 1] ?? ""}`}>
      {steps.map((label, i) => {
        const n = i + 1;
        const on = n === current;
        const done = n < current;
        return (
          <View
            key={label}
            style={{
              flex: 1,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: on ? color.amber : color.line,
              backgroundColor: on ? color.amberSoft : "transparent",
              gap: 2,
            }}
          >
            <Text style={{ fontFamily: fonts.monoBold, fontSize: 12, color: on ? color.amber : done ? color.success : color.textSubtle }}>{done ? "Done" : `Step ${n}`}</Text>
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13, color: on ? color.text : color.textMuted }}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}
