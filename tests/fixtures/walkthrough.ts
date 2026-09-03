export const exampleWalkthrough = {
  title: "Anatomy of a bar chart",
  steps: [
    {
      id: "data",
      playground_code: "values = [2, 4]\nprint(sum(values))",
      title: "Choose categories and values",
      code: "labels = ['a', 'b']\nvalues = [2, 4]",
      description:
        "Each label pairs with a value; the second bar is **twice as tall**, or $2x$.",
      annotations: [
        {
          id: "values",
          text: "These numbers determine the bar heights.",
          color: "blue",
          target: {
            kind: "code_range",
            start_line: 2,
            end_line: 2,
            start_column: 9,
            end_column: 14,
          },
        },
      ],
    },
    {
      id: "plot",
      title: "Draw the chart",
      code: "import matplotlib.pyplot as plt\n\nplt.bar(labels, values)\nplt.show()",
      description:
        "`bar` maps each value $v_i$ to height; `show` displays the figure.",
      annotations: [
        {
          id: "bars",
          text: "Draw the bars, then display the figure.",
          color: "blue-deep",
          target: { kind: "code_range", start_line: 3, end_line: 4 },
        },
      ],
    },
    {
      id: "inspect",
      title: "Inspect a longer example",
      code: Array.from(
        { length: 60 },
        (_, i) => `value_${i + 1} = ${i + 1}`,
      ).join("\n"),
      description:
        "Focus follows the final range $v_{58}\ldots v_{60}$ without changing it.",
      annotations: [
        {
          id: "last",
          text: "The focused range remains visible in long code.",
          color: "blue-light",
          target: { kind: "code_range", start_line: 58, end_line: 60 },
        },
      ],
    },
  ],
};
