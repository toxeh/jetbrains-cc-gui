package com.github.claudecodegui.handler;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class TranslationChunkerTest {

    @Test
    public void shortTextStaysOneChunk() {
        List<TranslationChunker.Chunk> chunks = TranslationChunker.split(
                "Hello world.", TranslationChunker.maxSourceTokens(TranslationChunker.REPLY_OUTPUT_PER_SOURCE));

        assertEquals(1, chunks.size());
        assertEquals("Hello world.", chunks.get(0).text);
        assertEquals("", chunks.get(0).separatorAfter);
    }

    @Test
    public void longTextSplitsOnTheBlankLineAndKeepsTheGap() {
        int budget = TranslationChunker.maxSourceTokens(TranslationChunker.REPLY_OUTPUT_PER_SOURCE);
        String paragraph = "A".repeat(budget * 4);
        String text = paragraph + "\n\n" + paragraph;

        List<TranslationChunker.Chunk> chunks = TranslationChunker.split(text, budget);

        assertEquals(2, chunks.size());
        assertEquals(paragraph, chunks.get(0).text);
        assertEquals("\n\n", chunks.get(0).separatorAfter);
        assertEquals(paragraph, chunks.get(1).text);
        for (TranslationChunker.Chunk chunk : chunks) {
            assertTrue(TranslationChunker.estimateTokens(chunk.text) <= budget);
        }
    }

    @Test
    public void placeholderIsNotCutInHalf() {
        int budget = TranslationChunker.maxSourceTokens(TranslationChunker.REPLY_OUTPUT_PER_SOURCE);
        String piece = "⟦LTk12⟧ ";
        String text = piece.repeat(80);

        List<TranslationChunker.Chunk> chunks = TranslationChunker.split(text, budget);

        assertTrue(chunks.size() > 1);
        for (TranslationChunker.Chunk chunk : chunks) {
            assertFalse(chunk.text.contains("⟦LT") && !chunk.text.contains("⟧"));
            assertEquals(0, count(chunk.text, "⟦") - count(chunk.text, "⟧"));
            assertTrue(TranslationChunker.estimateTokens(chunk.text) <= budget);
        }
    }

    @Test
    public void aLongLineSplitsOnTheSentence() {
        int budget = 80;
        String sentence = "This sentence is long enough to matter. ";
        String text = sentence.repeat(20);

        List<TranslationChunker.Chunk> chunks = TranslationChunker.split(text, budget);

        assertTrue(chunks.size() > 1);
        for (TranslationChunker.Chunk chunk : chunks) {
            assertTrue(chunk.text.endsWith("."));
            assertTrue(TranslationChunker.estimateTokens(chunk.text) <= budget);
        }
    }

    @Test
    public void whitespaceOverflowStillPrefersEarlierSentenceBoundary() {
        // "First. Second" is 13 ASCII chars; at budget=3 (12 ASCII chars), the 13th char
        // (index 12, the space in "First. Second word") is the overflowing unit.
        String text = "First. Second word";
        List<TranslationChunker.Chunk> chunks = TranslationChunker.split(text, 3);

        assertTrue(chunks.size() >= 2);
        assertEquals("First.", chunks.get(0).text);
        assertEquals(" ", chunks.get(0).separatorAfter);
    }

    private static int count(String text, String needle) {
        int n = 0;
        int from = 0;
        while (true) {
            int at = text.indexOf(needle, from);
            if (at < 0) {
                return n;
            }
            n++;
            from = at + needle.length();
        }
    }
}
