import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { PersistentMenuContext } from "./common";
import DropdownMenuGroup from "./DropdownMenuGroup";
import DropdownMenuItem from "./DropdownMenuItem";
import DropdownMenuItemCheckbox from "./DropdownMenuItemCheckbox";
import DropdownMenuItemContentRadio from "./DropdownMenuItemContentRadio";
import DropdownMenuItemCustom from "./DropdownMenuItemCustom";
import DropdownMenuItemLink from "./DropdownMenuItemLink";
import DropdownMenuSeparator from "./DropdownMenuSeparator";
import DropdownMenuSub from "./DropdownMenuSub";

describe("persistent dropdown menu", () => {
  it("renders without a Radix root and invokes actions with the native event", () => {
    const onSelect = vi.fn();
    const onClick = vi.fn();
    render(
      <PersistentMenuContext.Provider value={true}>
        <DropdownMenuGroup title="Actions">
          <DropdownMenuItem onClick={onClick} onSelect={onSelect}>
            Export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItemCustom>Custom content</DropdownMenuItemCustom>
        </DropdownMenuGroup>
      </PersistentMenuContext.Provider>,
    );

    const button = screen.getByRole("button", { name: "Export" });
    expect(button).toHaveAttribute("type", "button");
    button.focus();
    expect(fireEvent.keyDown(button, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(button, { key: "Escape" })).toBe(true);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(button, event);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(event);
    expect(button).toHaveFocus();
    expect(screen.getByText("Custom content")).toBeInTheDocument();
  });

  it("respects click cancellation and disabled actions", () => {
    const onSelect = vi.fn();
    render(
      <PersistentMenuContext.Provider value={true}>
        <DropdownMenuItem
          onClick={(event) => event.preventDefault()}
          onSelect={onSelect}
        >
          Cancelled
        </DropdownMenuItem>
        <DropdownMenuItem disabled onSelect={onSelect}>
          Disabled
        </DropdownMenuItem>
      </PersistentMenuContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    fireEvent.click(screen.getByRole("button", { name: "Disabled" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps nested preference controls available after selection", () => {
    const Preferences = () => {
      const [checked, setChecked] = React.useState(false);
      const [device, setDevice] = React.useState("mouse");
      return (
        <PersistentMenuContext.Provider value={true}>
          <DropdownMenuSub>
            <DropdownMenuSub.Trigger>Preferences</DropdownMenuSub.Trigger>
            <DropdownMenuSub.Content>
              <DropdownMenuItemCheckbox
                checked={checked}
                onSelect={(event) => {
                  setChecked((value) => !value);
                  event.preventDefault();
                }}
              >
                Grid
              </DropdownMenuItemCheckbox>
              <DropdownMenuItemContentRadio
                value={device}
                onChange={setDevice}
                name="device"
                choices={[
                  { value: "mouse", label: "Mouse", ariaLabel: "Mouse" },
                  {
                    value: "trackpad",
                    label: "Trackpad",
                    ariaLabel: "Trackpad",
                  },
                ]}
              >
                Input device
              </DropdownMenuItemContentRadio>
            </DropdownMenuSub.Content>
          </DropdownMenuSub>
        </PersistentMenuContext.Provider>
      );
    };
    render(<Preferences />);

    const summary = screen.getByText("Preferences").closest("summary")!;
    const details = summary.parentElement!;
    expect(details.tagName).toBe("DETAILS");
    summary.focus();
    expect(summary).toHaveFocus();
    expect(fireEvent.keyDown(summary, { key: "Enter" })).toBe(true);
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    const checkbox = screen.getByRole("checkbox", { name: "Grid" });
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Trackpad" }));
    expect(screen.getByRole("radio", { name: "Trackpad" })).toBeChecked();
    expect(details).toHaveAttribute("open");
  });

  it("preserves link attributes and selection cancellation", () => {
    const onSelect = vi.fn((event: Event) => event.preventDefault());
    render(
      <PersistentMenuContext.Provider value={true}>
        <DropdownMenuItemLink href="https://example.com" onSelect={onSelect}>
          Help
        </DropdownMenuItemLink>
      </PersistentMenuContext.Provider>,
    );

    const link = screen.getByRole("link", { name: "Help" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(fireEvent.click(link)).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
