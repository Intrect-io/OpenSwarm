import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { displayWidth } from '../cli/reviewProgress.js';
import { DataTable } from './components/DataTable.js';

describe('DataTable (EPIC INT-1813 S6)', () => {
  it('renders an empty state', () => {
    expect(render(<DataTable columns={['A']} rows={[]} empty="nothing here" />).lastFrame()).toContain('nothing here');
  });

  it('renders header + column-aligned rows', () => {
    const f = render(
      <DataTable columns={['ID', 'NAME']} rows={[['1', 'alpha'], ['2', 'beta']]} />,
    ).lastFrame()!;
    expect(f).toContain('ID');
    expect(f).toContain('NAME');
    expect(f).toContain('alpha');
    expect(f).toContain('beta');
  });

  it('truncates long cells to keep terminal layout bounded', () => {
    const f = render(
      <DataTable columns={['TITLE']} rows={[[`x`.repeat(30)]]} maxCellWidth={10} />,
    ).lastFrame()!;
    expect(f).toContain('xxxxxxxxx…');
    expect(f).not.toContain('x'.repeat(30));
  });

  it('truncates wide characters by terminal columns', () => {
    const f = render(
      <DataTable columns={['TITLE']} rows={[['작업상태확인']]} maxCellWidth={7} />,
    ).lastFrame()!;
    expect(f).toContain('작업상…');
    expect(f).not.toContain('작업상태확인');
  });

  it('flattens multiline cell text before clipping so newlines cannot bypass layout', () => {
    const f = render(
      <DataTable columns={['NOTE']} rows={[['line1\nline2\nline3']]} maxCellWidth={20} />,
    ).lastFrame()!;
    expect(f).toContain('line1 line2 line3');
    expect(f).not.toContain('\nline2');
  });

  it('keeps rendered rows within the terminal width', () => {
    const f = render(
      <DataTable
        columns={['FIRST', 'SECOND', 'THIRD']}
        rows={[['alpha-alpha-alpha', 'beta-beta-beta', 'gamma-gamma-gamma']]}
        maxCellWidth={20}
        terminalWidth={24}
      />,
    ).lastFrame()!;
    for (const line of f.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it('keeps a wide monitor table within a narrow terminal width', () => {
    const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    const row = columns.map((c) => `${c}${c}${c}${c}${c}`);
    const f = render(
      <DataTable columns={columns} rows={[row]} maxCellWidth={20} terminalWidth={24} />,
    ).lastFrame()!;
    for (const line of f.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(24);
    }
  });
});
