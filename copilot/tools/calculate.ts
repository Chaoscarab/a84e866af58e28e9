function calculate(operationOrExpression: string, num1?: number, num2?: number): number {
    if (typeof num1 === "number" && typeof num2 === "number") {
        switch (operationOrExpression) {
            case "add":
                return num1 + num2;
            case "subtract":
                return num1 - num2;
            case "multiply":
                return num1 * num2;
            case "divide":
                if (num2 === 0) {
                    throw new Error("Cannot divide by zero");
                }
                return num1 / num2;
            default:
                throw new Error("Invalid operation");
        }
    }

    const expression = operationOrExpression.trim();
    if (!expression) {
        throw new Error("Expression is empty");
    }

    const identifiers = expression.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
    const onlyAllowedIdentifiers = identifiers.every((identifier) => identifier === "Math.floor");
    if (!onlyAllowedIdentifiers) {
        throw new Error("Expression contains unsupported identifiers");
    }

    if (/[^0-9+\-*/%().,\sA-Za-z]/.test(expression)) {
        throw new Error("Expression contains unsupported characters");
    }

    const result = Function(`"use strict"; return (${expression});`)();
    if (typeof result !== "number" || Number.isNaN(result) || !Number.isFinite(result)) {
        throw new Error("Expression did not produce a valid number");
    }

    return result;
}

export { calculate };