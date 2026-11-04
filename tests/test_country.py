import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from country import country_zh  # noqa: E402


class CountryTests(unittest.TestCase):
    def test_variants_collapse_to_one_chinese_name(self):
        for value in ("美国", "United States", "us", "USA"):
            self.assertEqual(country_zh(value), "美国", value)
        self.assertEqual(country_zh("United Arab Emirates"), "阿拉伯联合酋长国")
        self.assertEqual(country_zh("Mexico"), "墨西哥")

    def test_empty_and_unknown(self):
        for value in (None, "", "未取得"):
            self.assertIsNone(country_zh(value))
        self.assertEqual(country_zh("Atlantis"), "Atlantis")


if __name__ == "__main__":
    unittest.main()
