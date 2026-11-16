// The one shared way to show an airport as "town, region (CODE)" (flows/missions.md MIS-7
// airport display). Identical copy in Trailhead and ACARS (src/renderer/places.js).
// Change every copy at the same time.
//
// - US, Canada and Australia: town and the state or province's short code: "Anchorage, AK".
// - Everywhere else: town and the country's name in the reader's language: "Tromsø, Norway".
// - No town recorded: the airport's name instead.
// Pages never build these labels themselves. Use window.CairnPlaces.
(function (root) {
  "use strict";

  const SHORT_REGION_COUNTRIES = new Set(["US", "CA", "AU"]);
  const countryNames = new Map();

  function countryName(code, language) {
    if (!code) return "";
    const key = `${language || ""}:${code}`;
    if (!countryNames.has(key)) {
      let name = code;
      try {
        const lang = language || (typeof navigator !== "undefined" && navigator.language) || "en";
        name = new Intl.DisplayNames([lang, "en"], { type: "region" }).of(code) || code;
      } catch {
        /* an unknown code or an old browser: show the code */
      }
      countryNames.set(key, name);
    }
    return countryNames.get(key);
  }

  /**
   * The words before the code, for example "Anchorage, AK". place: { code, name, town,
   * region (OurAirports iso_region, "US-AK"), country (two letters) }.
   */
  function label(place, language) {
    if (!place) return "";
    const town = (place.town || "").trim();
    const country = (place.country || "").trim().toUpperCase();
    let area = "";
    if (SHORT_REGION_COUNTRIES.has(country) && /^[A-Z]{2}-[A-Z0-9]{1,3}$/i.test(place.region || "")) {
      area = place.region.split("-")[1].toUpperCase();
    } else if (country) {
      area = countryName(country, language);
    }
    if (town) return area ? `${town}, ${area}` : town;
    const name = (place.name || "").trim();
    if (name) return area ? `${name}, ${area}` : name;
    return "";
  }

  /** Plain text, for places that can't hold a link: "Anchorage, AK (PANC)". */
  function text(place, language) {
    if (!place) return "";
    const words = label(place, language);
    return words ? `${words} (${place.code})` : place.code || "";
  }

  const CairnPlaces = { label, text, countryName };

  if (typeof module !== "undefined" && module.exports) module.exports = CairnPlaces;
  if (root) root.CairnPlaces = CairnPlaces;
})(typeof window !== "undefined" ? window : null);
