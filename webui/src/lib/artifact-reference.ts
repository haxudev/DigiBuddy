export const MANAGED_ARTIFACT_ID = /^[0-9a-f]{32}$/;
const UNSAFE_ARTIFACT_NAME = /[\u0000-\u001f\u007f<>:"/\\|?*]/u;

export function isManagedArtifactName(filename: string): boolean {
  return (
    Boolean(filename) &&
    filename.length <= 180 &&
    filename === filename.replace(/^[ .]+|[ .]+$/gu, "") &&
    !UNSAFE_ARTIFACT_NAME.test(filename)
  );
}
