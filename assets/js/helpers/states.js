/**
 * helpers/states.js — state-scoped lookups
 *
 * All functions are pure reads against the loaded store. None mutate.
 * Helpers fall back to null (not an exception) when a row is missing
 * (e.g. climate has no DC / HI / VI rows).
 */

import { getStore, STATE_NAMES } from '../data/store.js';

export function getAllStates() {
  return getStore().stateSummary.map((r) => r.state);
}

export function getStateOptions() {
  return getStore()
    .stateSummary
    .map((r) => ({ st: r.state, name: STATE_NAMES[r.state] || r.state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getStateSummary(st) {
  if (!st) return null;
  return getStore().stateSummary.find((r) => r.state === st) || null;
}

export function getStateClimate(st) {
  if (!st) return null;
  return getStore().climate.find((r) => r.state === st) || null;
}

export function getStateSports(st, limit = Infinity) {
  if (!st) return [];
  return getStore()
    .stateSportSummary
    .filter((r) => r.state === st)
    .slice()
    .sort((a, b) => b.athlete_count - a.athlete_count)
    .slice(0, limit);
}

export function getStateHometowns(st, limit = Infinity) {
  if (!st) return [];
  return getStore()
    .hometownSummary
    .filter((r) => r.hometown_state === st)
    .slice()
    .sort((a, b) => b.total_athletes - a.total_athletes)
    .slice(0, limit);
}
