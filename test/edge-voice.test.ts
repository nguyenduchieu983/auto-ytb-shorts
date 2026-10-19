import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setup } from './helpers';
import { mockNews, mockScript, mockStoryboard } from '../src/mock';
import { edgeVoice, edgeVoiceAlignment } from '../src/providers/edge-voice';

test('Nam Minh service word boundaries preserve narration and reject missing or wrong speech', () => {
  const board = mockStoryboard(mockScript(mockNews(new Date()).slice(0, 1)));
  const tokens = board.scenes.flatMap((s) => s.narration.split(/\s+/));
  const boundaries = tokens.map((word, i) => ({ word, start: i * 0.3, end: (i + 1) * 0.3 }));
  const aligned = edgeVoiceAlignment(board, boundaries, tokens.length * 0.3);
  assert.equal(aligned.alignment_coverage, 1);
  assert.equal(aligned.timings.length, board.scenes.length);
  assert.equal(aligned.words.map((w) => w.word).join(' '), tokens.join(' '));
  assert.throws(() => edgeVoiceAlignment(board, [], 55), /no audio/);
  assert.throws(
    () => edgeVoiceAlignment(board, [{ word: 'unrelated', start: 0, end: 1 }], 55),
    /coverage/,
  );
});

test('Nam Minh request preserves selected deep slow voice without requiring Piper model', async () => {
  const { c, pool } = await setup();
  c.LOCAL_VOICE_PROVIDER = 'edge';
  c.EDGE_TTS_RATE = '-15%';
  c.EDGE_TTS_PITCH = '-15Hz';
  c.LOCAL_VOICE_MODEL = 'missing-piper-model.onnx';
  const board = mockStoryboard(mockScript(mockNews(new Date()).slice(0, 1)));
  await mkdir(c.STORAGE_ROOT, { recursive: true });
  const dir = await mkdtemp(resolve(c.STORAGE_ROOT, 'edge-test-'));
  // Stop before subprocess launch: inspect the serialized input without contacting Edge.
  c.LOCAL_VOICE_PYTHON = join(dir, 'missing-python.exe');
  try {
    await assert.rejects(
      edgeVoice(
        c,
        { log: async () => {} } as any,
        {} as any,
        { runId: 'fixture', revision: 1, step: 'voice' },
        dir,
        board,
      ),
    );
    const input = JSON.parse(await readFile(join(dir, 'edge-voice-input.json'), 'utf8'));
    assert.equal(input.rate, '-15%');
    assert.equal(input.pitch, '-15Hz');
    assert.equal(input.voice, 'vi-VN-NamMinhNeural');
    assert.equal(input.narration, board.scenes.map((s) => s.narration).join(' '));
  } finally {
    await pool.end();
  }
});
