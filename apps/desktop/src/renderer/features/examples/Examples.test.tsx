import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Examples } from "./Examples";
import { bundledExamples } from "./catalog";

afterEach(cleanup);

it("opens the bundled document as a copy with the localized title", async () => {
  const onOpen = vi.fn().mockResolvedValue(undefined);
  const view = render(<Examples language="en" onOpen={onOpen} />);
  fireEvent.click(
    view.getByRole("button", { name: /Transformer Architecture/ }),
  );
  await waitFor(() =>
    expect(onOpen).toHaveBeenCalledWith(
      "Transformer Architecture",
      bundledExamples[0].content,
    ),
  );
});
