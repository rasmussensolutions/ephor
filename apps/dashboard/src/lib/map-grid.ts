export const mapGridSize = 24;
// Group content starts after its 1px border, 24px horizontal padding,
// 56px header and 4px top margin, relative to the shared canvas.
export const groupGridOffset = { x: 25, y: 61 };
export function snapMapPoint(x: number, y: number, offset = { x: 0, y: 0 }) {
  const snap = (value: number, origin: number) => {
    const first = Math.ceil(origin / mapGridSize);
    const last = Math.floor((20000 + origin) / mapGridSize);
    return (
      Math.max(
        first,
        Math.min(last, Math.round((value + origin) / mapGridSize)),
      ) *
        mapGridSize -
      origin
    );
  };
  return { x: snap(x, offset.x), y: snap(y, offset.y) };
}
