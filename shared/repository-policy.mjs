// Compatibility is limited to the exact HTTP repository URLs authorized here.
// Do not turn this into a general HTTP transport switch.
const httpRepositories = new Set(
  'baking campsite coffee course evse flower manhe milktea studyroom tattoo venue vipcard yanxi yshop yshopbbc'
    .split(' ')
    .map((slug) => `http://git.yin-duo.com/mini-program/${slug}.git`),
);

export function isAllowedHttpGitRepository(value) {
  return typeof value === 'string' && httpRepositories.has(value);
}
