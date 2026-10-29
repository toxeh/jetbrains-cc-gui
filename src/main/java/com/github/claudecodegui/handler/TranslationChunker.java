package com.github.claudecodegui.handler;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Splits masked prose so one chat completion fits the translator's context.
 *
 * <p>The local server is started with a 4096-token context. The fixed system text and the
 * person examples already occupy part of that window, and a Russian reply is several times
 * longer in tokens than its English source. Each piece is also kept small enough that the
 * reply can finish inside the 15 second HTTP timeout.
 */
final class TranslationChunker {

    static final int CONTEXT_TOKENS = 4096;
    static final int PROMPT_OVERHEAD_TOKENS = 320;
    /** Output cap so one call stays inside the 15s timeout at local decode speed. */
    static final int MAX_OUTPUT_TOKENS = 800;
    static final int PLACEHOLDER_TOKENS = 8;
    /** English source, Russian output. */
    static final int REPLY_OUTPUT_PER_SOURCE = 3;
    /** Russian source, English output. The source side is the larger one. */
    static final int PROMPT_OUTPUT_PER_SOURCE = 1;

    private static final Pattern PLACEHOLDER = Pattern.compile("⟦LT[^\\n⟧]*⟧");

    private TranslationChunker() {
    }

    static final class Chunk {
        final String text;
        /** Whitespace that followed this piece in the source, preserved when the pieces are joined. */
        final String separatorAfter;

        Chunk(String text, String separatorAfter) {
            this.text = text;
            this.separatorAfter = separatorAfter;
        }
    }

    static int maxSourceTokens(int outputPerSource) {
        int perSource = Math.max(1, outputPerSource);
        int byContext = (CONTEXT_TOKENS - PROMPT_OVERHEAD_TOKENS) / (1 + perSource);
        int byTime = MAX_OUTPUT_TOKENS / perSource;
        return Math.max(64, Math.min(byContext, byTime));
    }

    static int outputTokenBudget(int sourceTokens) {
        int room = CONTEXT_TOKENS - PROMPT_OVERHEAD_TOKENS - Math.max(sourceTokens, 1);
        return Math.max(64, Math.min(MAX_OUTPUT_TOKENS, room));
    }

    /**
     * ASCII prose is about four characters per token. Cyrillic and the ⟦LT…⟧ placeholders
     * are much denser, so they are counted separately.
     */
    static int estimateTokens(String text) {
        if (text == null || text.isEmpty()) {
            return 0;
        }
        int ascii = 0;
        int other = 0;
        int placeholders = 0;
        int i = 0;
        while (i < text.length()) {
            Matcher matcher = PLACEHOLDER.matcher(text);
            matcher.region(i, text.length());
            if (matcher.lookingAt()) {
                placeholders++;
                i = matcher.end();
            } else {
                if (text.charAt(i) < 128) {
                    ascii++;
                } else {
                    other++;
                }
                i++;
            }
        }
        return (ascii + 3) / 4 + other + placeholders * PLACEHOLDER_TOKENS;
    }

    static List<Chunk> split(String text, int maxSourceTokens) {
        if (text == null || text.isEmpty()) {
            return List.of();
        }
        if (estimateTokens(text) <= maxSourceTokens) {
            return List.of(new Chunk(text, ""));
        }
        List<Chunk> chunks = new ArrayList<>();
        int n = text.length();
        int i = 0;
        while (i < n) {
            int cut = findCut(text, i, maxSourceTokens);
            if (cut <= i) {
                cut = Math.min(n, i + 1);
            }
            String slice = text.substring(i, cut);
            int contentEnd = slice.length();
            while (contentEnd > 0 && Character.isWhitespace(slice.charAt(contentEnd - 1))) {
                contentEnd--;
            }
            if (contentEnd > 0) {
                chunks.add(new Chunk(slice.substring(0, contentEnd), slice.substring(contentEnd)));
            }
            i = cut;
        }
        return chunks;
    }

    private static int findCut(String text, int start, int maxSourceTokens) {
        int n = text.length();
        int ascii = 0;
        int other = 0;
        int placeholders = 0;
        int pos = start;
        int paragraph = -1;
        int line = -1;
        int sentence = -1;
        int space = -1;
        while (pos < n) {
            int next = nextUnitEnd(text, pos);
            boolean placeholder = next > pos + 1;
            int addAscii = !placeholder && text.charAt(pos) < 128 ? 1 : 0;
            int addOther = !placeholder && text.charAt(pos) >= 128 ? 1 : 0;
            int addPlaceholders = placeholder ? 1 : 0;
            int nextTokens = (ascii + addAscii + 3) / 4
                    + (other + addOther)
                    + (placeholders + addPlaceholders) * PLACEHOLDER_TOKENS;
            if (nextTokens > maxSourceTokens) {
                if (ascii == 0 && other == 0 && placeholders == 0) {
                    return next;
                }
                int boundary = latest(paragraph, line, sentence, space);
                if (boundary > start) {
                    return boundary;
                }
                if (Character.isWhitespace(text.charAt(pos))) {
                    int afterWs = pos;
                    while (afterWs < n && Character.isWhitespace(text.charAt(afterWs))) {
                        afterWs++;
                    }
                    return afterWs;
                }
                return pos;
            }
            ascii += addAscii;
            other += addOther;
            placeholders += addPlaceholders;
            pos = next;
            if (pos < n && Character.isWhitespace(text.charAt(pos))) {
                int afterWs = pos;
                while (afterWs < n && Character.isWhitespace(text.charAt(afterWs))) {
                    afterWs++;
                }
                String ws = text.substring(pos, afterWs);
                if (ws.contains("\n\n") || ws.contains("\r\n\r\n")) {
                    paragraph = afterWs;
                } else if (ws.indexOf('\n') >= 0 || ws.indexOf('\r') >= 0) {
                    line = afterWs;
                } else {
                    space = afterWs;
                }
                char prev = text.charAt(pos - 1);
                if (prev == '.' || prev == '!' || prev == '?') {
                    sentence = afterWs;
                }
            }
        }
        return n;
    }

    private static int latest(int paragraph, int line, int sentence, int space) {
        if (paragraph > 0) {
            return paragraph;
        }
        if (line > 0) {
            return line;
        }
        if (sentence > 0) {
            return sentence;
        }
        return space;
    }

    private static int nextUnitEnd(String text, int pos) {
        Matcher matcher = PLACEHOLDER.matcher(text);
        matcher.region(pos, text.length());
        if (matcher.lookingAt()) {
            return matcher.end();
        }
        return pos + 1;
    }
}
