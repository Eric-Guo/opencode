declare module "@zip.js/zip.js" {
  export class BlobWriter {
    constructor(contentType?: string)
    getData(): Promise<Blob>
  }

  export class BlobReader {
    constructor(blob: Blob)
  }

  export class ZipWriter {
    constructor(writer: BlobWriter)
    add(name: string, reader: BlobReader): Promise<void>
    close(): Promise<Blob>
  }
}
