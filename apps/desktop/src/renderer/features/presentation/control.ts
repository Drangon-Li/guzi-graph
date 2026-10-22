export type PresentationControlCommand = {
  action: "start" | "next" | "previous" | "goto" | "stop" | "status";
  slideId?: string;
};

export type PresentationControlState = {
  presenting: boolean;
  slideId: string | null;
  index: number;
  slideCount: number;
  fullscreen: boolean;
};

export interface PresentationController {
  execute(
    command: PresentationControlCommand,
  ): Promise<PresentationControlState>;
}
