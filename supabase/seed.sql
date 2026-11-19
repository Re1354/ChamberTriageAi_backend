-- ============================================================================
-- নমুনা নলেজ বেস (শুধু ডেভেলপমেন্ট/ডেমোর জন্য)
-- ⚠️ এগুলো ছোট উদাহরণ। আসল ব্যবহারের আগে একটা বৈধ, যাচাই করা ওষুধ-তালিকা দিয়ে বদলান
--    এবং একজন ডাক্তার/ফার্মাসিস্ট দিয়ে যাচাই করান।
-- ============================================================================

insert into public.kb_drugs (brand_name, generic_name, strength, dosage_form, drug_class, search_text) values
  ('Napa',     'Paracetamol',  '500 mg', 'tablet',  'Analgesic/antipyretic', 'Napa নাপা Paracetamol 500 mg'),
  ('Ace',      'Paracetamol',  '500 mg', 'tablet',  'Analgesic/antipyretic', 'Ace এইস Paracetamol 500 mg'),
  ('Seclo',    'Omeprazole',   '20 mg',  'capsule', 'Proton pump inhibitor', 'Seclo সেকলো Omeprazole 20 mg'),
  ('Sergel',   'Esomeprazole', '20 mg',  'capsule', 'Proton pump inhibitor', 'Sergel সার্জেল Esomeprazole 20 mg'),
  ('Maxpro',   'Esomeprazole', '20 mg',  'tablet',  'Proton pump inhibitor', 'Maxpro ম্যাক্সপ্রো Esomeprazole 20 mg'),
  ('Pantonix', 'Pantoprazole', '20 mg',  'tablet',  'Proton pump inhibitor', 'Pantonix প্যান্টোনিক্স Pantoprazole 20 mg'),
  ('Fexo',     'Fexofenadine', '120 mg', 'tablet',  'Antihistamine',         'Fexo ফেক্সো Fexofenadine 120 mg'),
  ('Alatrol',  'Cetirizine',   '10 mg',  'tablet',  'Antihistamine',         'Alatrol অ্যালাট্রল Cetirizine 10 mg'),
  ('Monas',    'Montelukast',  '10 mg',  'tablet',  'Leukotriene antagonist','Monas মোনাস Montelukast 10 mg'),
  ('Comet',    'Metformin',    '500 mg', 'tablet',  'Biguanide (antidiabetic)', 'Comet কমেট Metformin 500 mg'),
  ('Osartil',  'Losartan',     '50 mg',  'tablet',  'ARB (antihypertensive)', 'Osartil ওসারটিল Losartan 50 mg'),
  ('Camlodin', 'Amlodipine',   '5 mg',   'tablet',  'Calcium channel blocker','Camlodin ক্যামলোডিন Amlodipine 5 mg'),
  ('Ecosprin', 'Aspirin',      '75 mg',  'tablet',  'Antiplatelet',          'Ecosprin ইকোস্প্রিন Aspirin 75 mg')
on conflict do nothing;

insert into public.kb_symptoms (term_bn, variants, term_en, category, search_text) values
  ('বুকে ব্যথা',       '{বুক ব্যথা,বুকে চাপ,বুক ভার,বুক চাইপা ধরে}', 'Chest pain / pressure', 'cardio', 'বুকে ব্যথা বুক ব্যথা বুকে চাপ বুক ভার বুক চাইপা ধরে chest pain'),
  ('বুক ধড়ফড়',        '{বুক ধরফর,হার্ট বিট বেশি}',                 'Palpitations',          'cardio', 'বুক ধড়ফড় বুক ধরফর হার্ট বিট বেশি palpitations'),
  ('শ্বাসকষ্ট',         '{শ্বাস নিতে কষ্ট,দম বন্ধ লাগে,টান}',          'Shortness of breath',   'resp',   'শ্বাসকষ্ট শ্বাস নিতে কষ্ট দম বন্ধ লাগে টান dyspnea'),
  ('কাশি',              '{খুসখুসে কাশি,কফ}',                           'Cough',                 'resp',   'কাশি খুসখুসে কাশি কফ cough'),
  ('বুক জ্বালা',        '{অম্বল,গলা জ্বালা,টক ঢেকুর}',                'Heartburn',             'gastro', 'বুক জ্বালা অম্বল গলা জ্বালা টক ঢেকুর heartburn'),
  ('গ্যাস্ট্রিক',       '{গ্যাস,পেট ফাঁপা}',                          'Dyspepsia / bloating',  'gastro', 'গ্যাস্ট্রিক গ্যাস পেট ফাঁপা dyspepsia bloating'),
  ('পেটে ব্যথা',        '{পেট ব্যথা,পেট মোচড়ায়}',                     'Abdominal pain',        'gastro', 'পেটে ব্যথা পেট ব্যথা পেট মোচড়ায় abdominal pain'),
  ('পাতলা পায়খানা',    '{ডায়রিয়া,বারবার পায়খানা}',                  'Diarrhoea',             'gastro', 'পাতলা পায়খানা ডায়রিয়া বারবার পায়খানা diarrhoea'),
  ('বমি',               '{বমি বমি ভাব,বমি ভাব}',                       'Vomiting / nausea',     'gastro', 'বমি বমি বমি ভাব বমি ভাব vomiting nausea'),
  ('মাথাব্যথা',          '{মাথা ব্যথা,মাথা ধরা}',                       'Headache',              'neuro',  'মাথাব্যথা মাথা ব্যথা মাথা ধরা headache'),
  ('মাথা ঘোরা',         '{চোখে অন্ধকার দেখা,মাথা চক্কর}',             'Dizziness / vertigo',   'neuro',  'মাথা ঘোরা চোখে অন্ধকার দেখা মাথা চক্কর dizziness vertigo'),
  ('জ্বর',               '{গা গরম,কাঁপুনি দিয়ে জ্বর}',                 'Fever',                 'fever',  'জ্বর গা গরম কাঁপুনি দিয়ে জ্বর fever'),
  ('কোমর ব্যথা',        '{পিঠ ব্যথা,মাজা ব্যথা}',                      'Low back pain',         'msk',    'কোমর ব্যথা পিঠ ব্যথা মাজা ব্যথা back pain'),
  ('গিরা ব্যথা',        '{জয়েন্ট ব্যথা,হাঁটু ব্যথা}',                  'Joint pain',            'msk',    'গিরা ব্যথা জয়েন্ট ব্যথা হাঁটু ব্যথা joint pain'),
  ('প্রেশার',            '{হাই প্রেশার,উচ্চ রক্তচাপ}',                  'Hypertension',          'general','প্রেশার হাই প্রেশার উচ্চ রক্তচাপ hypertension'),
  ('সুগার',              '{ডায়াবেটিস,ডায়াবেটিক}',                     'Diabetes mellitus',     'general','সুগার ডায়াবেটিস ডায়াবেটিক diabetes')
on conflict do nothing;
