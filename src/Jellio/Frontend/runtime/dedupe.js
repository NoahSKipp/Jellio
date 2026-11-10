// Same title and year counts as the same item across rows.
export function titleKey(item) {
  return String(item.Name || '').trim().toLowerCase() + '|' + (item.ProductionYear || '');
}

// Drops items already in exclude (by id or title) and adds the rest to it.
export function dedupe(items, exclude) {
  const kept = [];
  items.forEach(function (item) {
    if (exclude[item.Id] || exclude[titleKey(item)]) return;
    exclude[item.Id] = true;
    exclude[titleKey(item)] = true;
    kept.push(item);
  });
  return kept;
}
