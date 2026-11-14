export const maxVsixBytes = 409_600;

export function vsixBudgetProblem(bytes) {
  if (bytes <= maxVsixBytes) {
    return undefined;
  }
  const size = (bytes / 1024).toFixed(1);
  return `The VSIX is ${size} KB, over the ${String(maxVsixBytes / 1024)} KB budget.`;
}
