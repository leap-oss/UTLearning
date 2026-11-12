/**
 * UT AI Learning Companion — Modular Alpine.js Shell Entry Point
 * Composes domain modules from /js/modules/*.js while preserving getters/setters.
 */
function mergeAppModules(...sources) {
  const target = {};
  for (const source of sources) {
    if (!source) continue;
    const descriptors = Object.getOwnPropertyDescriptors(source);
    for (const [key, desc] of Object.entries(descriptors)) {
      if ('value' in desc && desc.value && typeof desc.value === 'object' && !Array.isArray(desc.value)) {
        Object.defineProperty(target, key, {
          ...desc,
          value: JSON.parse(JSON.stringify(desc.value)),
        });
      } else if ('value' in desc && Array.isArray(desc.value)) {
        Object.defineProperty(target, key, {
          ...desc,
          value: [...desc.value],
        });
      } else {
        Object.defineProperty(target, key, desc);
      }
    }
  }
  return target;
}

document.addEventListener('alpine:init', () => {
  const M = window.AppModules || {};
  Alpine.data('appShell', () =>
    mergeAppModules(
      M.state,
      M.apiAndJobs,
      M.coursesAndModules,
      M.sourcesAndExtraction,
      M.studyPackAndReader,
      M.quizAndRemedial,
      M.mathAndFormatters
    )
  );
});
