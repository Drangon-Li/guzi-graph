import transformerArchitecture from "../../../../../../examples/guzi/transformer-architecture.excalidraw?raw";
import transformerPreview from "../../../../../../examples/guzi/transformer-architecture.png";

export const bundledExamples = [
  {
    id: "transformer-architecture",
    title: "Transformer 架构",
    description: "完整的编码器与解码器结构，包含 QKV 详解和子画布笔记。",
    content: transformerArchitecture,
    preview: transformerPreview,
  },
] as const;
