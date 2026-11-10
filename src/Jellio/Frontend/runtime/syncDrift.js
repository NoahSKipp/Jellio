// Where a group command puts the player. A paused group stays where the
// command says; only a playing one has moved on since the command's time.
export function syncTargetTicks(command, estimateCurrentTicks) {
  const position = (command && command.PositionTicks) || 0;
  if (!command || command.Command === 'Pause' || !command.When) return position;
  return estimateCurrentTicks(position, command.When);
}

export function syncDriftSeconds(currentTicks, command, estimateCurrentTicks, ticksPerSecond) {
  return Math.abs(currentTicks - syncTargetTicks(command, estimateCurrentTicks)) / ticksPerSecond;
}
