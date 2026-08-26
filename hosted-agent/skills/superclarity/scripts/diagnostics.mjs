export function capDiagnostics(diagnostics) {
  if (diagnostics.length <= 50) return diagnostics;
  const omitted = diagnostics.length - 49;
  return [
    ...diagnostics.slice(0, 49),
    { code: 'SC199', severity: 'error', location: null, detail: `${omitted} additional diagnostics omitted` },
  ];
}
