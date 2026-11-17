// Разбор строк сервера: TPS и список игроков.
// Эти строки в интерфейсе видит человек — поэтому проверяем ровно те форматы,
// которые печатают Paper/Spigot, Forge и ванильный сервер.
use omnipanel_core::players::parse_tps;

#[test]
fn tps_из_строки_paper_читается() {
    /* «TPS from last 1m, 5m, 15m: 19.9, 20.0, 20.0» — раньше это давало None:
       в число попадала запятая-разделитель. График TPS не работал вовсе. */
    assert_eq!(parse_tps("TPS from last 1m, 5m, 15m: 19.9, 20.0, 20.0"), Some(19.9));
    assert_eq!(
        parse_tps("[12:00:00] [Server thread/INFO]: TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"),
        Some(20.0)
    );
}

#[test]
fn tps_из_строки_forge_читается() {
    assert_eq!(parse_tps("Mean TPS: 19.845"), Some(19.845));
    assert_eq!(parse_tps("20.000 TPS"), Some(20.0));
}

#[test]
fn обычные_строки_не_принимаются_за_tps() {
    assert_eq!(parse_tps("Done (1.2s)! For help, type \"help\""), None);
    assert_eq!(parse_tps("Запуск: java -jar server.jar nogui"), None);
    assert_eq!(parse_tps(""), None);
}
