import { queryArchive } from "./queryArchive.js";

async function getArchiveWord(page: string, position: number): Promise<string> {
    const summary = await queryArchive(page);
    const extract = typeof summary?.extract === "string" ? summary.extract : "";

    if (!extract) {
        throw new Error("Archive extract was empty or unavailable");
    }

    if (!Number.isInteger(position) || position <= 0) {
        throw new Error("Position must be a positive integer");
    }

    const words = extract.match(/[A-Za-z0-9'-]+/g) ?? [];
    const word = words[position - 1];

    if (!word) {
        throw new Error("Requested word position is out of range");
    }

    return word;
}

export { getArchiveWord };
