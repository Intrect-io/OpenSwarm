import { describe, expect, it } from 'vitest';
import { assertsKey, claimsGate, gateClaimIssue, reportedKeys, unassertedReportedKeys } from './gateClaimGuard.js';

// The AUD-731 shape (de-artifact 1a9a54c): the host reads the property, checks
// the call succeeded, and writes the returned number into the QC JSON. The
// shell gate list is untouched.
const MINIHOST_ADDED = [
  'var presetNumber: Int32 = 0',
  'let status = AudioUnitGetProperty(au, kAudioUnitProperty_PresentPreset, kAudioUnitScope_Global, 0, &preset, &presetSize)',
  'report["present_preset_status"] = status == noErr',
  'report["present_preset_number"] = presetNumber',
].join('\n');

// The fix (b0a8177): au_qc.sh gates on the reported number.
const AU_QC_FIX_ADDED = 'if [ "$(jq -r .present_preset_number "$out")" != "-1" ]; then echo "FAIL present_preset_number"; exit 1; fi';

describe('gateClaimGuard (AGT-3107)', () => {
  describe('claimsGate', () => {
    it.each([
      'test(au-qc): gate on PresentPreset — AUD-731 regression class',
      'Adds a regression guard for the settlement rounding.',
      'introduced a CI gate that fails when coverage drops',
      'this guards against the empty-list case',
      '회귀 테스트를 추가했습니다',
      '게이트 추가: silent_bug',
    ])('sees a gate claim in %j', (text) => {
      expect(claimsGate(text)).toBe(true);
    });

    it.each([
      'fixes a regression in the parser',
      'updated the gate config path',
      'refactor: move the tests directory',
      '',
    ])('does not read %j as a gate claim', (text) => {
      expect(claimsGate(text)).toBe(false);
    });
  });

  describe('reportedKeys', () => {
    it('collects keys reported with a computed value, in file order, once each', () => {
      const keys = reportedKeys([
        { file: 'scripts/au_qc/MiniHost.swift', added: MINIHOST_ADDED },
        { file: 'scripts/report.sh', added: 'printf \'{"present_preset_number": %s, "frames_rendered": %s}\' "$n" "$frames"' },
      ]);
      expect(keys).toEqual(['present_preset_status', 'present_preset_number', 'frames_rendered']);
    });

    it('reads the escaped-quote form a shell or Swift string uses to build JSON', () => {
      expect(reportedKeys([{ file: 'host.swift', added: 'out += "\\"present_preset_number\\": \\(presetNumber)"' }]))
        .toEqual(['present_preset_number']);
    });

    it('ignores literals, structural keys, data files and test files', () => {
      expect(reportedKeys([
        { file: 'a.ts', added: '{ "version": build, "retries": 3, "name": pkg.name, "label": "x", "enabled": true, "items": [] }' },
        { file: 'fixture.json', added: '{ "present_preset_number": computeIt() }' },
        { file: 'host.test.ts', added: 'const r = { "present_preset_number": read() };' },
      ])).toEqual([]);
    });
  });

  describe('assertsKey', () => {
    it('accepts a comparison on the same line', () => {
      expect(assertsKey(AU_QC_FIX_ADDED, 'present_preset_number')).toBe(true);
    });

    it('accepts a shell test operator and a jq -e', () => {
      expect(assertsKey('[ "$(jq -r .frames_rendered f)" -gt 0 ] || exit 1', 'frames_rendered')).toBe(true);
      expect(assertsKey('jq -e \'.silent_bug == false\' "$out"', 'silent_bug')).toBe(true);
    });

    it('accepts a multi-line expect whose object literal names the key', () => {
      const text = 'expect(report).toEqual({\n  present_preset_status: true,\n  present_preset_number: -1,\n});';
      expect(assertsKey(text, 'present_preset_number')).toBe(true);
    });

    it('rejects a mention that only reports or logs the key', () => {
      expect(assertsKey(MINIHOST_ADDED, 'present_preset_number')).toBe(false);
      expect(assertsKey('console.log("present_preset_number", n)', 'present_preset_number')).toBe(false);
      expect(assertsKey('', 'present_preset_number')).toBe(false);
    });
  });

  describe('unassertedReportedKeys', () => {
    it('flags the AUD-731 shape: the number is reported and nothing in the change or the tree checks it', () => {
      const files = [{ file: 'scripts/au_qc/MiniHost.swift', added: MINIHOST_ADDED }];
      expect(unassertedReportedKeys(files, () => '')).toEqual(['present_preset_number']);
    });

    it('passes once the shell gate in the same change compares the number', () => {
      const files = [
        { file: 'scripts/au_qc/MiniHost.swift', added: MINIHOST_ADDED },
        { file: 'scripts/au_qc.sh', added: AU_QC_FIX_ADDED },
      ];
      expect(unassertedReportedKeys(files, () => '')).toEqual([]);
    });

    it('passes when untouched code in the tree already asserts the key', () => {
      const files = [{ file: 'scripts/au_qc/MiniHost.swift', added: MINIHOST_ADDED }];
      const tree = (key: string) => (key === 'present_preset_number' ? AU_QC_FIX_ADDED : '');
      expect(unassertedReportedKeys(files, tree)).toEqual([]);
    });

    it('still flags when the tree only mentions the key without asserting it', () => {
      const files = [{ file: 'scripts/au_qc/MiniHost.swift', added: MINIHOST_ADDED }];
      expect(unassertedReportedKeys(files, () => '# present_preset_number is reported for information')).toEqual(['present_preset_number']);
    });
  });

  it('names every unasserted key in the issue text', () => {
    expect(gateClaimIssue(['present_preset_number'])).toContain('reports a value nothing asserts: `present_preset_number`');
    expect(gateClaimIssue(['a_key', 'b_key'])).toContain('reports values nothing asserts: `a_key`, `b_key`');
  });
});
