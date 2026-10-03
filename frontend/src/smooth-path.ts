type Point = readonly [number, number];

/** Monotone cubic interpolation: rounded joins without inventing new extrema. */
export function smoothPath(points: (Point | null)[]): string {
  const run = (values: Point[]) => {
    if (!values.length) return '';
    if (values.length === 1) return `M ${values[0][0]} ${values[0][1]}`;
    const slopes = values.slice(1).map((point, index) => (point[1] - values[index][1]) / (point[0] - values[index][0]));
    const tangents = values.map((_, index) => {
      if (index === 0) return slopes[0];
      if (index === values.length - 1) return slopes.at(-1)!;
      const left = slopes[index - 1], right = slopes[index];
      return left * right <= 0 ? 0 : Math.sign(left) * Math.min(Math.abs(left), Math.abs(right), .5 * Math.abs(left + right));
    });
    return `M ${values[0][0]} ${values[0][1]} ` + values.slice(1).map((point, index) => {
      const previous = values[index], dx = point[0] - previous[0];
      return `C ${previous[0] + dx / 3} ${previous[1] + tangents[index] * dx / 3} ${point[0] - dx / 3} ${point[1] - tangents[index + 1] * dx / 3} ${point[0]} ${point[1]}`;
    }).join(' ');
  };
  const paths: string[] = [];
  let current: Point[] = [];
  for (const point of [...points, null]) {
    if (point) current.push(point);
    else if (current.length) { paths.push(run(current)); current = []; }
  }
  return paths.join(' ');
}
