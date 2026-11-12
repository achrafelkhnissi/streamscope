export function confirmOnce(ask: () => Promise<boolean>): () => Promise<boolean> {
  let answer: Promise<boolean> | undefined;
  return () => {
    answer ??= ask().then((confirmed) => {
      if (!confirmed) {
        answer = undefined;
      }
      return confirmed;
    });
    return answer;
  };
}
