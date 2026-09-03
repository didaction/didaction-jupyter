export const exampleWalkthrough = {
  title: "Anatomy of a bar chart",
  steps: [
    {
      id: "data",
      title: "Choose categories and values",
      code: "labels = ['a', 'b']\nvalues = [2, 4]",
      markdown:
        "## Two categories, two values\nEach label pairs with a value. The second bar will be **twice as tall** as the first.",
      annotations: [
        {
          id: "values",
          start_line: 2,
          end_line: 2,
          start_column: 9,
          end_column: 14,
          text: "These numbers determine the bar heights.",
          color: "blue",
        },
      ],
    },
    {
      id: "plot",
      title: "Draw the chart",
      code: "import matplotlib.pyplot as plt\n\nplt.bar(labels, values)\nplt.show()",
      markdown:
        "## Turn data into a picture\n`bar` maps the values to heights. `show` displays the figure.\n\nThis code is an explanation, not an executable playground.",
      annotations: [
        {
          id: "bars",
          start_line: 3,
          end_line: 4,
          text: "Draw the bars, then display the figure.",
          color: "blue-deep",
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
      markdown:
        "## Follow the annotation\nFocusing a range scrolls the code pane to reveal it. Clear focus to stop the pulse without deleting the annotation.",
      annotations: [
        {
          id: "last",
          start_line: 58,
          end_line: 60,
          text: "The focused range remains visible in long code.",
          color: "blue-light",
        },
      ],
    },
  ],
};
