using System;
using System.Collections.Generic;
using System.Text;

namespace Snake;

public record struct Point(int X, int Y);

public enum Dir { Up, Down, Left, Right }

public class Board
{
    public int Width { get; }
    public int Height { get; }

    public Board(int width, int height)
    {
        Width = width;
        Height = height;
    }

    public bool Contains(Point p) => p.X >= 0 && p.Y >= 0 && p.X < Width && p.Y < Height;
}

public class Game
{
    private readonly Random _rng;
    private readonly List<Point> _body = new();
    private Dir _dir = Dir.Right;

    public Board Board { get; }
    public Point Food { get; private set; }
    public int Score { get; private set; }
    public bool Over { get; private set; }
    public bool Won { get; private set; }

    public Game(int seed, int width = 17, int height = 15)
    {
        _rng = new Random(seed);
        Board = new Board(width, height);
        int row = height / 2;
        for (int i = 0; i < 4; i++) _body.Add(new Point(4 - i, row));
        Food = new Point(width * 3 / 4, row);
    }

    public void Turn(Dir d)
    {
        bool opposite = (_dir == Dir.Up && d == Dir.Down) || (_dir == Dir.Down && d == Dir.Up)
                     || (_dir == Dir.Left && d == Dir.Right) || (_dir == Dir.Right && d == Dir.Left);
        if (!opposite) _dir = d;
    }

    public void Step()
    {
        if (Over) return;
        Point head = _body[0];
        Point next = _dir switch
        {
            Dir.Up => new Point(head.X, head.Y - 1),
            Dir.Down => new Point(head.X, head.Y + 1),
            Dir.Left => new Point(head.X - 1, head.Y),
            _ => new Point(head.X + 1, head.Y),
        };
        // the tail cell is free this tick unless the snake is about to eat
        bool eating = next == Food;
        int check = eating ? _body.Count : _body.Count - 1;
        bool hitSelf = false;
        for (int i = 0; i < check; i++)
        {
            if (_body[i] == next) { hitSelf = true; break; }
        }
        if (!Board.Contains(next) || hitSelf)
        {
            Over = true;
            return;
        }
        _body.Insert(0, next);
        if (eating)
        {
            Score++;
            if (_body.Count >= Board.Width * Board.Height)
            {
                Over = true;
                Won = true;
                return;
            }
            PlaceFood();
        }
        else
        {
            _body.RemoveAt(_body.Count - 1);
        }
    }

    private void PlaceFood()
    {
        Point p;
        do
        {
            p = new Point(_rng.Next(Board.Width), _rng.Next(Board.Height));
        } while (_body.Contains(p));
        Food = p;
    }

    // Line 1: width height score state(0 playing, 1 over, 2 won) foodX foodY. Line 2: snake cells, head first.
    public string Render()
    {
        var sb = new StringBuilder();
        sb.Append(Board.Width).Append(' ').Append(Board.Height).Append(' ').Append(Score).Append(' ')
          .Append(Over ? (Won ? 2 : 1) : 0).Append(' ').Append(Food.X).Append(' ').Append(Food.Y).AppendLine();
        for (int i = 0; i < _body.Count; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(_body[i].X).Append(',').Append(_body[i].Y);
        }
        sb.AppendLine();
        return sb.ToString();
    }
}

public static class Program
{
    // Usage: Snake --replay <seed> <moves>   (moves: U/D/L/R/. per tick) prints the frame after the last tick.
    public static void Main(string[] args)
    {
        if (args.Length >= 3 && args[0] == "--replay")
        {
            var game = new Game(int.Parse(args[1]));
            foreach (char c in args[2])
            {
                switch (c)
                {
                    case 'U': game.Turn(Dir.Up); break;
                    case 'D': game.Turn(Dir.Down); break;
                    case 'L': game.Turn(Dir.Left); break;
                    case 'R': game.Turn(Dir.Right); break;
                }
                game.Step();
            }
            Console.Write(game.Render());
            return;
        }

        var g = new Game(Environment.TickCount);
        Console.Write(g.Render());
    }
}
