export const withStopPropagation = (handler?: (e: any) => void) => {
  return (e: any) => {
    e.stopPropagation();
    if (handler) {
      handler(e);
    }
  };
};