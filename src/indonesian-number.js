const ONES = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan'];

function spellUnderThousand(value) {
  if (value < 10) return ONES[value];
  if (value === 10) return 'sepuluh';
  if (value === 11) return 'sebelas';
  if (value < 20) return `${ONES[value - 10]} belas`;
  if (value < 100) {
    const remainder = value % 10;
    return `${ONES[Math.floor(value / 10)]} puluh${remainder ? ` ${ONES[remainder]}` : ''}`;
  }
  if (value === 100) return 'seratus';
  if (value < 200) return `seratus ${spellUnderThousand(value - 100)}`;
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  return `${ONES[hundreds]} ratus${remainder ? ` ${spellUnderThousand(remainder)}` : ''}`;
}

export function integerToIndonesianWords(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('value must be a non-negative safe integer');
  }
  if (value < 1000) return spellUnderThousand(value);
  if (value === 1000) return 'seribu';
  if (value < 2000) return `seribu ${spellUnderThousand(value - 1000)}`;

  for (const [base, label] of [[1_000_000_000, 'miliar'], [1_000_000, 'juta'], [1000, 'ribu']]) {
    if (value >= base) {
      const leading = Math.floor(value / base);
      const remainder = value % base;
      const prefix = base === 1000 && leading === 1 ? 'seribu' : `${integerToIndonesianWords(leading)} ${label}`;
      return remainder ? `${prefix} ${integerToIndonesianWords(remainder)}` : prefix;
    }
  }
  return spellUnderThousand(value);
}

export function rupiahToIndonesianWords(amount) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError('amount must be a non-negative finite number');
  }
  const rounded = Math.round(amount);
  const words = integerToIndonesianWords(rounded);
  return `${words[0].toUpperCase()}${words.slice(1)} rupiah`;
}
