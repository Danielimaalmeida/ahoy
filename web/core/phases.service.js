/**
 * Everything this app knows about the pipeline comes from
 * knowledge/process/phases.tsv, loaded once at startup and read from here.
 *
 * Nothing below hardcodes a phase name. Add a row to the table and the strip,
 * the badges and the decision panel follow it - which is the point of the
 * table being the ground truth rather than a comment.
 */
import { list } from './format.js';

class PhasesService {
  constructor() {
    this.rows = [];
    this.mainline = [];
    this.humanGates = {};
    this.terminal = [];
  }

  load(payload) {
    this.rows = list(payload.rows);
    this.mainline = list(payload.mainline);
    this.humanGates = payload.human_gates || {};
    this.terminal = list(payload.terminal);
    this.byPhase = new Map(this.rows.map((row) => [row.phase, row]));
    return this;
  }

  row(phase) {
    return this.byPhase.get(phase) || null;
  }

  /** The gate a human moves at this phase, or null if the router moves it. */
  gate(phase) {
    return this.humanGates[phase] || null;
  }

  isTerminal(phase) {
    return this.terminal.includes(phase);
  }

  /** Does passing this phase land the story on a human? */
  leadsToHuman(phase) {
    const row = this.row(phase);
    return !!(row && this.humanGates[row.on_pass]);
  }

  /**
   * Badge colour for a phase, derived rather than listed:
   *   green  finished cleanly        red  stopped
   *   amber  waiting on a human      blue  one step from waiting on a human
   *   grey   running unattended
   */
  badgeClass(phase) {
    if (this.isTerminal(phase)) return phase === 'done' ? 'b-ok' : 'b-bad';
    if (this.gate(phase)) return 'b-warn';
    if (this.leadsToHuman(phase)) return 'b-acc';
    return 'b-mute';
  }

  /** Which phase does each gate script belong to, so a result can be placed. */
  phaseOfGate(gateScript) {
    const row = this.rows.find((r) => r.gate && r.gate === gateScript);
    return row ? row.phase : null;
  }

  /**
   * The progress strip: one entry per mainline phase, with its state.
   *
   * On the happy path, position in the mainline decides everything. Off it -
   * `blocked`, or an unknown phase - there is no position to compare against,
   * so gate_results are used instead: a gate that recorded a pass got the story
   * through that phase, and the one that recorded a fail is where it stopped.
   * That is the whole reason gates write their own results.
   */
  steps(state) {
    const current = state.phase;
    const index = this.mainline.indexOf(current);
    const results = this.latestGateResults(state);

    return this.mainline.map((phase, i) => {
      let status;
      if (index >= 0) {
        status = i < index ? 'done' : i === index ? 'now' : 'ahead';
      } else {
        const result = results.get(phase);
        status = result === 'fail' ? 'fail' : result === 'pass' ? 'done' : 'ahead';
      }
      return { phase, status, human: !!this.gate(phase) };
    });
  }

  /** Latest recorded result per phase, keyed by phase rather than gate script. */
  latestGateResults(state) {
    const latest = new Map();
    for (const entry of list(state.gate_results)) {
      if (!entry || typeof entry !== 'object') continue;
      const phase = this.phaseOfGate(entry.gate);
      if (phase) latest.set(phase, entry.result);
    }
    return latest;
  }
}

export const phases = new PhasesService();
