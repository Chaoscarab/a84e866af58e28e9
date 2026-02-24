type SpeakTextConstraints = {
    min?: number;
    max?: number;
    exact?: number;
};

type SpeakTextValidation = {
    valid: boolean;
    length: number;
    constraints: SpeakTextConstraints;
    reason?: string;
};

function parseSpeakTextConstraints(challengeSentence: string): SpeakTextConstraints {
    const sentence = String(challengeSentence ?? "");

    const betweenMatch = sentence.match(/between\s+(\d+)\s+and\s+(\d+)\s+total\s+characters?/i);
    if (betweenMatch) {
        const min = Number.parseInt(betweenMatch[1], 10);
        const max = Number.parseInt(betweenMatch[2], 10);
        return { min, max };
    }

    const exactMatch = sentence.match(/exactly\s+(\d+)\s+(?:total\s+)?characters?/i);
    if (exactMatch) {
        const exact = Number.parseInt(exactMatch[1], 10);
        return { exact };
    }

    const minMatch = sentence.match(/at\s+least\s+(\d+)\s+(?:total\s+)?characters?/i);
    const maxMatch = sentence.match(/at\s+most\s+(\d+)\s+(?:total\s+)?characters?/i);
    if (minMatch || maxMatch) {
        return {
            min: minMatch ? Number.parseInt(minMatch[1], 10) : undefined,
            max: maxMatch ? Number.parseInt(maxMatch[1], 10) : undefined,
        };
    }

    const lessThanMatch = sentence.match(/(?:in\s+)?(?:less|fewer)\s+than\s+(\d+)\s+(?:total\s+)?characters?/i);
    if (lessThanMatch) {
        const upperExclusive = Number.parseInt(lessThanMatch[1], 10);
        return { max: upperExclusive - 1 };
    }

    const greaterThanMatch = sentence.match(/(?:in\s+)?more\s+than\s+(\d+)\s+(?:total\s+)?characters?/i);
    if (greaterThanMatch) {
        const lowerExclusive = Number.parseInt(greaterThanMatch[1], 10);
        return { min: lowerExclusive + 1 };
    }

    const underMatch = sentence.match(/(?:in\s+)?under\s+(\d+)\s+(?:total\s+)?characters?/i);
    if (underMatch) {
        const upperExclusive = Number.parseInt(underMatch[1], 10);
        return { max: upperExclusive - 1 };
    }

    const overMatch = sentence.match(/(?:in\s+)?over\s+(\d+)\s+(?:total\s+)?characters?/i);
    if (overMatch) {
        const lowerExclusive = Number.parseInt(overMatch[1], 10);
        return { min: lowerExclusive + 1 };
    }

    return {};
}

function validateSpeakText(text: string, challengeSentence: string): SpeakTextValidation {
    const normalizedText = String(text ?? "");
    const length = normalizedText.length;
    const constraints = parseSpeakTextConstraints(challengeSentence);

    if (typeof constraints.exact === "number") {
        if (length !== constraints.exact) {
            return {
                valid: false,
                length,
                constraints,
                reason: `Text length must be exactly ${constraints.exact} characters, but got ${length}.`,
            };
        }
        return { valid: true, length, constraints };
    }

    if (typeof constraints.min === "number" && length < constraints.min) {
        return {
            valid: false,
            length,
            constraints,
            reason: `Text length must be at least ${constraints.min} characters, but got ${length}.`,
        };
    }

    if (typeof constraints.max === "number" && length > constraints.max) {
        return {
            valid: false,
            length,
            constraints,
            reason: `Text length must be at most ${constraints.max} characters, but got ${length}.`,
        };
    }

    return { valid: true, length, constraints };
}

export { parseSpeakTextConstraints, validateSpeakText };