import java.io.*;
import java.util.*;

public class WordCount {
    public static void main(String[] args) {
        File inputFile = new File("input.txt");
        Map<String, Integer> wordCount = new HashMap<>();
        
        if (!inputFile.exists()) {
            try {
                inputFile.createNewFile();
                try (BufferedWriter writer = new BufferedWriter(new FileWriter(inputFile))) {
                    writer.write("apple");
                    writer.newLine();
                    writer.write("banana");
                    writer.newLine();
                    writer.write("apple");
                    writer.newLine();
                    writer.write("orange");
                    writer.newLine();
                    writer.write("banana");
                    writer.newLine();
                    writer.write("banana");
                    writer.newLine();
                    writer.write("kiwi");
                    writer.newLine();
                    writer.write("kiwi");
                    writer.newLine();
                    writer.write("kiwi");
                    writer.newLine();
                    writer.write("apple");
                    writer.newLine();
                    writer.write("orange");
                }
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
        
        try {
            try (BufferedReader reader = new BufferedReader(new FileReader(inputFile))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String word = line.trim().toLowerCase();
                    if (!word.isEmpty()) {
                        wordCount.put(word, wordCount.getOrDefault(word, 0) + 1);
                    }
                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
        
        List<Map.Entry<String, Integer>> sortedEntries = new ArrayList<>(wordCount.entrySet());
        sortedEntries.sort((a, b) -> b.getValue().compareTo(a.getValue()));
        
        for (int i = 0; i < Math.min(10, sortedEntries.size()); i++) {
            Map.Entry<String, Integer> entry = sortedEntries.get(i);
            System.out.println(entry.getKey() + ": " + entry.getValue());
        }
    }
}