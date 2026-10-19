import {
  fileOpen as _fileOpen,
  fileSave as _fileSave,
  supported as nativeFileSystemSupported,
} from "browser-fs-access";

import { MIME_TYPES } from "@excalidraw/common";

import { normalizeFile } from "./blob";

type FILE_EXTENSION = Exclude<keyof typeof MIME_TYPES, "binary">;

export const fileOpen = async <M extends boolean | undefined = false>(opts: {
  extensions?: FILE_EXTENSION[];
  description: string;
  multiple?: M;
}): Promise<M extends false | undefined ? File : File[]> => {
  // an unsafe TS hack, alas not much we can do AFAIK
  type RetType = M extends false | undefined ? File : File[];

  const mimeTypes = opts.extensions?.reduce((mimeTypes, type) => {
    mimeTypes.push(MIME_TYPES[type]);

    return mimeTypes;
  }, [] as string[]);

  const extensions = opts.extensions?.reduce((acc, ext) => {
    if (ext === "jpg") {
      return acc.concat(".jpg", ".jpeg");
    }
    return acc.concat(`.${ext}`);
  }, [] as string[]);

  const files = await _fileOpen({
    description: opts.description,
    extensions,
    mimeTypes,
    multiple: opts.multiple ?? false,
  });

  if (Array.isArray(files)) {
    return (await Promise.all(
      files.map((file) => normalizeFile(file)),
    )) as RetType;
  }
  return (await normalizeFile(files)) as RetType;
};

export type FileSaveOptions = {
  /** supply without the extension */
  name: string;
  extension: FILE_EXTENSION;
  mimeTypes?: string[];
  description: string;
  fileHandle?: FileSystemFileHandle | null;
};

export type FileSystemAdapter = {
  fileSave: (
    blob: Blob,
    opts: FileSaveOptions,
  ) => Promise<FileSystemFileHandle | null>;
};

let fileSystemAdapter: FileSystemAdapter | null = null;

/** Set once by a desktop host; pass null to restore browser file saving. */
export const setFileSystemAdapter = (adapter: FileSystemAdapter | null) => {
  fileSystemAdapter = adapter;
};

export const fileSave = async (
  blob: Blob | Promise<Blob>,
  opts: FileSaveOptions,
) => {
  if (fileSystemAdapter) {
    return fileSystemAdapter.fileSave(await blob, opts);
  }
  return _fileSave(
    blob,
    {
      fileName: `${opts.name}.${opts.extension}`,
      description: opts.description,
      extensions: [`.${opts.extension}`],
      mimeTypes: opts.mimeTypes,
    },
    opts.fileHandle,
    false,
  );
};

export { nativeFileSystemSupported };
