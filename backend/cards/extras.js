// Recipe photo, cuisine and video (TheMealDB).
// (No translation enrichment: free translation memories return unvetted user entries.)
import { cached, compact, getJson, norm, sameName } from './util.js';

export async function enrichRecipe(data) {
  if (!data?.title) return null;
  // TheMealDB matches substrings, so "Spaghetti Carbonara" needs a search for "carbonara".
  const words = norm(data.title).split(' ').filter((w) => w.length > 3).sort((x, y) => y.length - x.length);
  let meal = null;
  for (const q of [data.title, ...words.slice(0, 2)]) {
    const res = await cached(`meal:${norm(q)}`, 24 * 3600e3, () =>
      getJson(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`));
    meal = (res?.meals ?? []).find((m) => sameName(m.strMeal, data.title));
    if (meal) break;
  }
  if (!meal) return null;
  return {
    data: compact({ imageUrl: meal.strMealThumb, cuisine: meal.strArea, category: meal.strCategory, videoUrl: meal.strYoutube || undefined, sourceUrl: meal.strSource || undefined }),
    prefer: 'stated',
    sources: ['TheMealDB'],
  };
}
