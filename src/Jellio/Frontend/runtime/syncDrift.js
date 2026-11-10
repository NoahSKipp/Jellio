// Where a group command puts the player. A paused group stays where the
// command says; only a playing one has moved on since the command's time.
// A Pause with no position has no target: the player pauses where it is.
export function syncTargetTicks(command, estimateCurrentTicks) {
  if (command && command.Command === 'Pause') return command.PositionTicks == null ? null : command.PositionTicks;
  const position = (command && command.PositionTicks) || 0;
  if (!command || !command.When) return position;
  return estimateCurrentTicks(position, command.When);
}

export function syncDriftSeconds(currentTicks, command, estimateCurrentTicks, ticksPerSecond) {
  const target = syncTargetTicks(command, estimateCurrentTicks);
  if (target == null) return 0;
  return Math.abs(currentTicks - target) / ticksPerSecond;
}
