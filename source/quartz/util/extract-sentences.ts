export const extractSentences = (text: string, minLength: number = 32): string[] => {
    if (!text || text.length === 0) {
        return [];
    }

    // Sentence-ending punctuation patterns
    const sentenceEnders = [
        '. ', '? ', '! ',  // Basic sentence endings with space
        '.\n', '?\n', '!\n', '\n',  // Sentence endings with newline
        '.\"', '?\"', '!\"',  // Sentence endings with closing quote
        '."', '?"', '!"',     // Sentence endings with single quote
        '.\t', '?\t', '!\t',  // Sentence endings with tab
    ];

    // Helper function to trim and clean a sentence
    const cleanSentence = (str: string): string => {
        return str.trim().replace(/\s+/g, ' ');
    };

    const sentences: string[] = [];
    let remainingText = text;

    while (remainingText.length > 0) {
        // Find the earliest sentence ending
        let earliestEnd = -1;
        let endingPattern = '';

        for (const ender of sentenceEnders) {
            const pos = remainingText.indexOf(ender);
            if (pos !== -1 && (earliestEnd === -1 || pos < earliestEnd)) {
                earliestEnd = pos;
                endingPattern = ender;
            }
        }

        // If no sentence ending is found, treat the remaining text as the last sentence
        if (earliestEnd === -1) {
            const cleanedContent = cleanSentence(remainingText);
            if (cleanedContent.length >= minLength) {
                sentences.push(cleanedContent);
            }
            break;
        }

        // Extract the sentence including the ending punctuation
        const sentenceWithEnding = remainingText.slice(0, earliestEnd + endingPattern.length);
        const cleanedContent = cleanSentence(sentenceWithEnding);

        // Only add sentences that meet the minimum length requirement
        if (cleanedContent.length >= minLength) {
            sentences.push(cleanedContent);
        }

        // Update remaining text
        remainingText = remainingText.slice(earliestEnd + endingPattern.length);
    }

    return sentences;
}; 