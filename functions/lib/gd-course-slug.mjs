/* The one server-side course slug. Every function that turns a course name or id into
   a course_id / facility_key imports this, so they cannot drift apart again.

   NFD-normalised before the character filter, because [^a-z0-9] does not eat a
   macron - it eats the letter WITH the macron. "Ngāruawāhia Golf Club" slugged to
   "ng-ruawahia-golf-club" and "Ōtaki Golf Club" to "taki-golf-club". Decomposing first
   turns ā into a + a combining mark, and the mark is what gets dropped.

   Must stay byte-identical to courseKey() in app/js/course-key.js and the browser
   copies that carry the same comment; dev/course-slug.test.js holds them together.

   No length cap and no fallback: callers keep their own (.slice(0, 90), || "course"),
   because those differ by table and changing them would move existing ids. */
export function courseSlug(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
