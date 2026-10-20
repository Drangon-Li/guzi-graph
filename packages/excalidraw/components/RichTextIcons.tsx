import { createIcon } from "./icons";

const options = {
  width: 24,
  height: 24,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const RichTextListNoneIcon = createIcon(
  <path d="M4 6h16M4 12h16M4 18h16" />,
  options,
);
export const RichTextListBulletIcon = createIcon(
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4" cy="6" r="1" />
    <circle cx="4" cy="12" r="1" />
    <circle cx="4" cy="18" r="1" />
  </>,
  options,
);
export const RichTextListOrderedIcon = createIcon(
  <>
    <path d="M10 6h10M10 12h10M10 18h10M3 4h1v4M3 8h3M3 11c0-2 3-2 3 0 0 1-3 2-3 4h3M3 17h3l-2 2c3-1 3 3-1 2" />
  </>,
  options,
);
export const RichTextIndentIcon = createIcon(
  <path d="M4 5h16M10 10h10M10 14h10M4 19h16M3 9l3 3-3 3" />,
  options,
);
export const RichTextOutdentIcon = createIcon(
  <path d="M4 5h16M10 10h10M10 14h10M4 19h16M6 9l-3 3 3 3" />,
  options,
);
export const RichTextJustifyIcon = createIcon(
  <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  options,
);

export const RichTextLineSpacingIcons = [3, 6, 9].map((gap) =>
  createIcon(
    <>
      <path d={`M9 ${12 - gap}h12M9 12h12M9 ${12 + gap}h12`} />
      <path d="M4 4v16M2 6l2-2 2 2M2 18l2 2 2-2" />
    </>,
    options,
  ),
);

export const RichTextParagraphSpacingIcons = [2, 4, 6].map((gap) =>
  createIcon(
    <>
      <path
        d={`M9 ${9 - gap}h12M9 ${12 - gap}h8M9 ${12 + gap}h12M9 ${15 + gap}h8`}
      />
      <path
        d={`M4 ${10 - gap}v${4 + gap * 2}M2 ${12 - gap}l2-2 2 2M2 ${
          12 + gap
        }l2 2 2-2`}
      />
    </>,
    options,
  ),
);
