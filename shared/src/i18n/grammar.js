/**
 * Minimal morphology for the languages whose adjectives agree with the noun.
 *
 * Italian, French and Russian put the qualifier after the commodity name and
 * inflect it for gender and number: "Diamanti levigati", not the German-shaped
 * "Diamanti levigato".  Getting that wrong is visible in every market row, so
 * the catalogue infers the noun class with orthographic rules and corrects the
 * exceptions from an explicit table.
 *
 * German is not handled here: the German templates are written out in full, and
 * the three stylised German variants derive from them.  Chinese and English do
 * not inflect in this position.
 */

/** Nouns whose ending lies about their class. */
const IT_EXCEPTIONS = new Map(Object.entries({
  'Segale': 'fs', 'Miele': 'ms', 'Pesce salato': 'ms', 'Caviale': 'ms',
  'Pollame': 'ms', 'Carne salata': 'fs', 'Noce moscata': 'fs',
  'Minerale di ferro': 'ms', 'Minerale di rame': 'ms', 'Minerale di stagno': 'ms',
  'Minerale d\'argento': 'ms', 'Minerale d\'oro': 'ms', 'Minerale': 'ms',
  'Sestante': 'ms', 'Polvere da sparo': 'fs', 'Polvere': 'fs',
  'Calce viva': 'fs', 'Razione antiscorbuto': 'fs', 'Razione': 'fs',
  'Cannone': 'ms', 'Merce rubata': 'fs', 'Merce': 'fs', 'Orchidee': 'fp',
  'Banane': 'fp', 'Mele': 'fp', 'Bacche': 'fp', 'Cassa medica': 'fs',
  'Attrezzi': 'mp', 'Aratri': 'mp', 'Moschetti': 'mp', 'Mitraglia': 'fs',
  'Gioielli': 'mp', 'Argenteria': 'fs', 'Orologi': 'mp', 'Diamanti': 'mp',
  'Rubini': 'mp', 'Zaffiri': 'mp', 'Smeraldi': 'mp', 'Dipinti': 'mp',
  'Manoscritti': 'mp', 'Strumenti musicali': 'mp', 'Libri': 'mp',
  'Uccelli esotici': 'mp', 'Semi rari': 'mp', 'Tappeti': 'mp', 'Arazzo': 'ms',
  'Specchi': 'mp', 'Mattoni': 'mp', 'Fanali di bordo': 'mp', 'Chiodi da nave': 'mp',
  'Pennoni di scorta': 'mp', 'Assi': 'fp', 'Documenti falsi': 'mp',
  'Liquori di contrabbando': 'mp', 'Contrabbando di guerra': 'ms',
  'Tabacco non tassato': 'ms', 'Reliquia antica': 'fs', 'Bronzo di relitto': 'ms',
  'Squama di sirena': 'fs', 'Legna da ardere': 'fs', 'Legno di quercia': 'ms',
  'Legno di pino': 'ms', 'Alberi da nave': 'mp', 'Galletta': 'fs',
  'Barili d\'acqua': 'mp', 'Tela da vele': 'fs', 'Tela velica': 'fs',
  'Stoppa da calafataggio': 'fs', 'Olio da lampada': 'ms', 'Olio d\'oliva': 'ms',
  'Olio di balena': 'ms', 'Ambra grigia': 'fs', 'Corteccia di china': 'fs',
  'Unguento alle erbe': 'ms', 'Cassetta del carpentiere': 'fs',
  'Vetro da finestra': 'ms', 'Chiodi': 'mp', 'Cordame': 'ms',
  'Riso': 'ms', 'Mais': 'ms', 'Miglio': 'ms', 'Grano': 'ms', 'Sale': 'ms',
  'Pepe': 'ms', 'Zenzero': 'ms', 'Tè': 'ms', 'Caffè': 'ms', 'Cacao': 'ms',
  'Rum': 'ms', 'Brandy': 'ms', 'Sidro': 'ms', 'Vino': 'ms', 'Miele': 'ms',
  'Zucchero': 'ms', 'Cuoio': 'ms', 'Ferro': 'ms', 'Acciaio': 'ms',
  'Rame': 'ms', 'Bronzo': 'ms', 'Ottone': 'ms', 'Piombo': 'ms',
  'Stagno': 'ms', 'Argento': 'ms', 'Oro': 'ms', 'Carbone': 'ms',
  'Granito': 'ms', 'Marmo': 'ms', 'Calcare': 'ms', 'Ardesia': 'fs',
  'Lino': 'ms', 'Cotone': 'ms', 'Velluto': 'ms', 'Broccato': 'ms',
  'Bambù': 'ms', 'Teak': 'ms', 'Mogano': 'ms', 'Ebano': 'ms',
  'Catrame': 'ms', 'Pece': 'fs', 'Cordame': 'ms', 'Canapa': 'fs',
  'Vetrame': 'ms', 'Zolfo': 'ms', 'Salnitro': 'ms', 'Allume': 'ms',
  'Sapone': 'ms', 'Liscivia': 'fs', 'Indaco': 'ms', 'Guado': 'ms',
  'Robbia': 'fs', 'Cocciniglia': 'fs', 'Porpora': 'fs', 'Ocra': 'fs',
  'Oppio': 'ms', 'Canfora': 'fs', 'Incenso': 'ms', 'Profumo': 'ms',
  'Giada': 'fs', 'Corallo': 'ms', 'Ambra': 'fs', 'Carta': 'fs',
  'Pergamena': 'fs', 'Inchiostro': 'ms', 'Tabacco': 'ms', 'Bussola': 'fs',
  'Sestante': 'ms', 'Clessidra': 'fs', 'Tartaruga': 'fs', 'Ossidiana': 'fs',
  'Alghe': 'fp', 'Ostriche': 'fp', 'Perle': 'fp', 'Pecore': 'fp',
  'Capre': 'fp', 'Uova': 'fp', 'Pellicce': 'fp', 'Patate': 'fp',
  'Cipolle': 'fp', 'Olive': 'fp', 'Mele': 'fp', 'Bacche': 'fp',
  'Bende': 'fp', 'Reti da pesca': 'fp', 'Armature': 'fp', 'Sciabole d\'arrembaggio': 'fp',
  'Ancore': 'fp', 'Carte nautiche': 'fp', 'Carte stellari': 'fp',
  'Palle di cannone': 'fp', 'Balle': 'fp', 'Ceramiche': 'fp', 'Sculture': 'fp',
  'Casse': 'fp', 'Giare': 'fp',
}));

const FR_EXCEPTIONS = new Map(Object.entries({
  'Pommes de terre': 'fp', 'Pommes': 'fp', 'Oignons': 'mp', 'Chou': 'ms',
  'Agrumes': 'mp', 'Noix de coco': 'fp', 'Noix': 'fp', 'Baies': 'fp',
  'Champignons': 'mp', 'Canne à sucre': 'fs', 'Canne': 'fs',
  'Morue': 'fs', 'Poisson salé': 'ms', 'Thon': 'ms', 'Crabe': 'ms',
  'Crevettes': 'fp', 'Huîtres': 'fp', 'Caviar': 'ms', 'Huile de baleine': 'fs',
  'Huile à lampe': 'fs', 'Huile d\'olive': 'fs', 'Huile': 'fs',
  'Ambre gris': 'ms', 'Perles': 'fp', 'Algues': 'fp', 'Bovins': 'mp',
  'Moutons': 'mp', 'Chèvres': 'fp', 'Porcs': 'mp', 'Volaille': 'fs',
  'Chevaux': 'mp', 'Viande salée': 'fs', 'Viande': 'fs', 'Œufs': 'mp',
  'Fourrures': 'fp', 'Clous de girofle': 'mp', 'Clous': 'mp',
  'Tonneaux d\'eau': 'mp', 'Tonneaux': 'mp', 'Eau-de-vie': 'fs',
  'Planches': 'fp', 'Mâts': 'mp', 'Minerai de fer': 'ms', 'Minerai': 'ms',
  'Briques': 'fp', 'Miroirs': 'mp', 'Verre à vitre': 'ms', 'Verre': 'ms',
  'Ancres': 'fp', 'Clous de marine': 'mp', 'Vergues de rechange': 'fp',
  'Vergues': 'fp', 'Fanaux de bord': 'mp', 'Fanaux': 'mp',
  'Cartes marines': 'fp', 'Cartes': 'fp', 'Bois de chauffage': 'ms',
  'Bois': 'ms', 'Charbon de bois': 'ms', 'Tourbe': 'fs',
  'Poudre à canon': 'fs', 'Poudre': 'fs', 'Coffre à remèdes': 'ms',
  'Écorce de quinquina': 'fs', 'Écorce': 'fs', 'Onguent aux herbes': 'ms',
  'Bandages': 'mp', 'Ration antiscorbut': 'fs', 'Ration': 'fs',
  'Outils à main': 'mp', 'Outils': 'mp', 'Trousse de charpentier': 'fs',
  'Filets de pêche': 'mp', 'Filets': 'mp', 'Charrues': 'fp', 'Canon': 'ms',
  'Boulets de canon': 'mp', 'Boulets': 'mp', 'Mousquets': 'mp',
  'Sabres d\'abordage': 'mp', 'Sabres': 'mp', 'Armures': 'fp',
  'Mitraille': 'fs', 'Bijoux': 'mp', 'Argenterie': 'fs', 'Horloges': 'fp',
  'Diamants': 'mp', 'Rubis': 'mp', 'Saphirs': 'mp', 'Émeraudes': 'fp',
  'Tableaux': 'mp', 'Sculptures': 'fp', 'Manuscrits': 'mp',
  'Instruments de musique': 'mp', 'Instruments': 'mp', 'Livres': 'mp',
  'Alcool de contrebande': 'ms', 'Alcool': 'ms', 'Faux papiers': 'mp',
  'Cargaison volée': 'fs', 'Cargaison': 'fs', 'Tabac non taxé': 'ms',
  'Contrebande de guerre': 'fs', 'Contrebande': 'fs', 'Oiseaux exotiques': 'mp',
  'Oiseaux': 'mp', 'Graines rares': 'fp', 'Graines': 'fp', 'Orchidées': 'fp',
  'Relique antique': 'fs', 'Relique': 'fs', 'Cartes stellaires': 'fp',
  'Obsidienne': 'fs', 'Bronze d\'épave': 'ms', 'Écaille de sirène': 'fs',
  'Écaille': 'fs', 'Tapis': 'mp', 'Biscuit de mer': 'ms', 'Biscuit': 'ms',
  'Toile de voile': 'fs', 'Toile': 'fs', 'Chaux': 'fs', 'Sablier': 'ms',
  'Blé': 'ms', 'Seigle': 'ms', 'Orge': 'fs', 'Avoine': 'fs', 'Riz': 'ms',
  'Maïs': 'ms', 'Millet': 'ms', 'Farine': 'fs', 'Sel': 'ms', 'Poivre': 'ms',
  'Cannelle': 'fs', 'Muscade': 'fs', 'Safran': 'ms', 'Gingembre': 'ms',
  'Vanille': 'fs', 'Cardamome': 'fs', 'Paprika': 'ms', 'Bière': 'fs',
  'Vin': 'ms', 'Rhum': 'ms', 'Cidre': 'ms', 'Thé': 'ms', 'Café': 'ms',
  'Cacao': 'ms', 'Miel': 'ms', 'Sucre': 'ms', 'Lin': 'ms', 'Coton': 'ms',
  'Soie': 'fs', 'Velours': 'ms', 'Brocart': 'ms', 'Toile à voile': 'fs',
  'Tapisserie': 'fs', 'Bois de chêne': 'ms', 'Bois de pin': 'ms',
  'Teck': 'ms', 'Acajou': 'ms', 'Ébène': 'fs', 'Bambou': 'ms',
  'Fer': 'ms', 'Acier': 'ms', 'Cuivre': 'ms', 'Bronze': 'ms',
  'Laiton': 'ms', 'Plomb': 'ms', 'Étain': 'ms', 'Argent': 'ms', 'Or': 'ms',
  'Charbon': 'ms', 'Granit': 'ms', 'Marbre': 'ms', 'Calcaire': 'ms',
  'Ardoise': 'fs', 'Poterie': 'fs', 'Porcelaine': 'fs', 'Verrerie': 'fs',
  'Cordage': 'ms', 'Chanvre': 'ms', 'Goudron': 'ms', 'Poix': 'fs',
  'Étoupe': 'fs', 'Boussole': 'fs', 'Sextant': 'ms', 'Sablier': 'ms',
  'Soufre': 'ms', 'Salpêtre': 'ms', 'Alun': 'ms', 'Savon': 'ms',
  'Lessive': 'fs', 'Chaux vive': 'fs', 'Indigo': 'ms', 'Cochenille': 'fs',
  'Garance': 'fs', 'Pastel': 'ms', 'Pourpre': 'fs', 'Ocre': 'fs',
  'Opium': 'ms', 'Camphre': 'ms', 'Encens': 'ms', 'Parfum': 'ms',
  'Jade': 'ms', 'Corail': 'ms', 'Ambre': 'ms', 'Papier': 'ms',
  'Parchemin': 'ms', 'Encre': 'fs', 'Tabac': 'ms', 'Ivoire': 'ms',
  'Cuir': 'ms', 'Laine': 'fs', 'Fromage': 'ms', 'Beurre': 'ms',
  'Obsidienne': 'fs', 'Écaille de tortue': 'fs',
}));

const RU_EXCEPTIONS = new Map(Object.entries({
  'Сельдь': 'f', 'Шерсть': 'f', 'Ваниль': 'f', 'Латунь': 'f',
  'Кошениль': 'f', 'Картечь': 'f', 'Ячмень': 'm', 'Картофель': 'm',
  'Имбирь': 'm', 'Уголь': 'm', 'Янтарь': 'm', 'Жемчуг': 'm',
  'Оливки': 'p', 'Финики': 'p', 'Бананы': 'p', 'Кокосы': 'p', 'Яблоки': 'p',
  'Ягоды': 'p', 'Грибы': 'p', 'Крабы': 'p', 'Креветки': 'p', 'Устрицы': 'p',
  'Овцы': 'p', 'Козы': 'p', 'Свиньи': 'p', 'Лошади': 'p', 'Яйца': 'p',
  'Меха': 'p', 'Ковры': 'p', 'Доски': 'p', 'Дрова': 'p', 'Канаты': 'p',
  'Якоря': 'p', 'Алмазы': 'p', 'Рубины': 'p', 'Сапфиры': 'p', 'Изумруды': 'p',
  'Картины': 'p', 'Скульптуры': 'p', 'Рукописи': 'p', 'Книги': 'p',
  'Мушкеты': 'p', 'Доспехи': 'p', 'Ядра': 'p', 'Плуги': 'p', 'Зеркала': 'p',
  'Часы': 'p', 'Бинты': 'p', 'Орхидеи': 'p', 'Квасцы': 'p', 'Кирпич': 'm',
  'Цитрусовые': 'p', 'Морские': 'p', 'Сухари': 'p', 'Ювелирные': 'p',
  'Музыкальные': 'p', 'Экзотические': 'p', 'Редкие': 'p', 'Поддельные': 'p',
  'Абордажные': 'p', 'Судовые': 'p', 'Запасные': 'p', 'Рыболовные': 'p',
  'Столовое': 'n', 'Оконное': 'n', 'Чёрное': 'n', 'Красное': 'n',
  'Древние': 'p', 'Звёздные': 'p', 'Противоцинготный': 'm', 'Травяная': 'f',
  'Медицинский': 'm', 'Ручной': 'm', 'Плотницкий': 'm', 'Тунец': 'm',
  'Треска': 'f', 'Солёная': 'f', 'Солонина': 'f', 'Пакля': 'f', 'Вар': 'm',
  'Парусина': 'f', 'Парусное': 'n', 'Древняя': 'f', 'Чешуя': 'f',
  'Соль': 'f', 'Сталь': 'f', 'Медь': 'f', 'Рожь': 'f', 'Ткань': 'f',
  'Смола': 'f', 'Пенька': 'f', 'Сера': 'f', 'Селитра': 'f', 'Известь': 'f',
  'Мука': 'f', 'Пшеница': 'f', 'Кукуруза': 'f', 'Капуста': 'f',
  'Шерсть': 'f', 'Кожа': 'f', 'Икра': 'f', 'Амбра': 'f', 'Ваниль': 'f',
  'Корица': 'f', 'Гвоздика': 'f', 'Паприка': 'f', 'Бумага': 'f',
  'Слоновая кость': 'f', 'Древесный уголь': 'm', 'Оливковое масло': 'n',
  'Ламповое масло': 'n', 'Масло': 'n', 'Мыло': 'n', 'Вино': 'n',
  'Пиво': 'n', 'Золото': 'n', 'Серебро': 'n', 'Железо': 'n', 'Олово': 'n',
  'Просо': 'n', 'Зерно': 'n', 'Сукно': 'n', 'Полотно': 'n',
}));

/** Italian: -o m.sg, -a f.sg, -i m.pl, -e ambiguous (default f.sg). */
export function classifyIt(name) {
  const hit = IT_EXCEPTIONS.get(name);
  if (hit) return hit;
  const head = name.split(/\s+(?:di|da|d'|del|della|delle|dei)\b/)[0].trim();
  const exHead = IT_EXCEPTIONS.get(head);
  if (exHead) return exHead;
  const w = head.toLowerCase();
  if (w.endsWith('i')) return 'mp';
  if (w.endsWith('o')) return 'ms';
  if (w.endsWith('a')) return 'fs';
  if (w.endsWith('e')) return 'fp';   // most -e commodity plurals are feminine
  return 'ms';
}

/** French: -s/-x plural; -e feminine singular; otherwise masculine singular. */
export function classifyFr(name) {
  const hit = FR_EXCEPTIONS.get(name);
  if (hit) return hit;
  const head = name.split(/\s+(?:de|du|des|d'|à|en)\b/)[0].trim();
  const exHead = FR_EXCEPTIONS.get(head);
  if (exHead) return exHead;
  const w = head.toLowerCase();
  const plural = /[sx]$/.test(w) && !/(?:ais|ois|us|as|os)$/.test(w);
  const feminine = /(?:e|es)$/.test(w) && !/(?:ge|re|le|be|ne|me)$/.test(w);
  if (plural) return feminine ? 'fp' : 'mp';
  return feminine ? 'fs' : 'ms';
}

/** Russian: -ы/-и plural, -а/-я feminine, -о/-е neuter, consonant masculine. */
export function classifyRu(name) {
  const hit = RU_EXCEPTIONS.get(name);
  if (hit) return hit;
  const head = name.split(/\s+/)[0];
  const exHead = RU_EXCEPTIONS.get(head);
  if (exHead) return exHead;
  const w = head.toLowerCase();
  if (/[ыи]$/.test(w)) return 'p';
  if (/[ая]$/.test(w)) return 'f';
  if (/[ое]$/.test(w)) return 'n';
  if (/ь$/.test(w)) return 'm';
  return 'm';
}

/** Pick the correct form from an inflection table for a language. */
export function inflect(table, lang, name) {
  if (!table) return null;
  if (lang === 'it') return table[classifyIt(name)] ?? table.ms;
  if (lang === 'fr') return table[classifyFr(name)] ?? table.ms;
  if (lang === 'ru') return table[classifyRu(name)] ?? table.m;
  return null;
}
