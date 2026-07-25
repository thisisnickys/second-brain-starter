'use strict';
// Zero-dep local-time date formatting (YYYY-MM-DD), no UTC conversion.
function localDate(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { localDate };
